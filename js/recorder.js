// 記録（record → stop → save）。静止点に留まって連続エポックを収集し、
// 停止時に「ばらつき（DRMS / CEP / 散布図）」を集計する。
//   record: 下書きを作ってから収集開始。autoStop 有効時は「最低 minSec 秒 → 中心・DRMS が
//           holdSec 秒横ばい」で自動停止する（docs/algospec-202607.md 3.）。
//   stop:   収集停止。集計して下書きに書き足す。まだ地点にはしない。
//   save:   ラベル・メモを付けて確定する（record-ui.js 側。地点番号はそこで採番）。
// 集計は accuracy.js の computeStaticStats。測定区間の受信品質（rxStats）も
// summary に残す（docs/algospec-202607.md 5.）。
//
// **記録中に 5 エポックごとチャンクを追記する**のがこのモジュールの要。停止まで
// メモリに溜め込まないので、アプリが落ちても直近フラッシュまでは残る。停止時に
// 1.6MB の生NMEA を一度に書いていた頃のような、まとまった書き込みも起きない。
//
// 1地点の記録で 2 系統を同時に集める（仕様 4-8）:
//   GNSS受信機   生NMEA行（rawNmea）＋ パース済みエポック（samples）
//   Android内蔵  OS の測位（deviceSamples）
// どちらも同じチャンクへ入れ、確定時に地点番号（surveyId + pointNo）を付けるので、
// 1日に何十地点まわっても「どの受信機データとどの Android データが対か」は後から必ず辿れる。
// 2系統が本当に同じ時間に取れていたかは window.overlap で検証する（js/survey.js）。
//
// データが届かなくなったら停止する（仕様 3-7）。画面OFF・BLE切断・受信機の電池切れ・
// fix 喪失を一様に拾うため、契機は「画面が隠れたか」ではなく「エポックが来ているか」。
// 記録タブの UI 配線（ボタン・表示）は record-ui.js 側。
import { computeStaticStats, computeDeviceStats, evaluateConvergence } from './accuracy.js';
import { diffRxStats } from './stream-stats.js';
import { buildWindow, surveyIdOf } from './survey.js';

// 収束自動停止の判定パラメータ（設定画面には出さないモジュール定数）
const CONVERGENCE = { holdSec: 10, centerTolM: 0.3, drmsTolAbsM: 0.3, drmsTolPct: 0.05 };

// データ途絶で打ち切るまでの時間 [ms]。1Hz なので通常は 1 秒間隔でエポックが来る。
// BLE の瞬断は自動再接続で復帰する（transport.js のバックオフ 500ms 起点）ため、
// 再接続が間に合う長さにする。短くすると瞬断のたびに記録が終わってしまう。
const STALL_MS = 10000;

// 何エポックぶんを 1 チャンクにまとめるか。1 エポックごとでも動くがトランザクションが
// 5 倍になる。5 秒ぶんを失っても集計はほとんど動かないので、この粒度で釣り合う。
const FLUSH_EPOCHS = 5;

// フラッシュがこの回数続けて失敗したら記録を打ち切る。以降のデータを取り続けても残せない。
const MAX_FLUSH_FAILURES = 3;

// データ不足の確認を出す条件。1Hz なので 30 秒あれば 30 点が期待値で、
// 10 点未満は取得率 33% 未満。computeStaticStats は 1 点でも値を返すため、
// このまま地点にすると DRMS がほぼ 0 という偽の「良い値」が残ってしまう。
const INSUFFICIENT = { minSec: 30, minCount: 10 };

// 生NMEA行の上限（保険）。maxSec=0（無制限）で走らせ続けても DB を圧迫しないようにする。
// 1Hz で 10〜20 行/秒なので、20000 行 ≈ 20〜30 分ぶん（約 1.6 MB）。
// 打ち切った場合は rawTruncated に本数を残し、記録が途中までであることを隠さない。
// （フラッシュのたびにバッファを捨てるので、メモリ側の理由での上限ではなくなった。）
const MAX_RAW_LINES = 20000;

// サンプル列が実際にデータを返していた長さ [秒]。0〜1点なら 0。
// 時刻軸は端末時計（recvAt）に揃える。2系統で共通に持つのはこれだけのため。
function spanSecOf(samples) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples || []) {
    const t = s?.recvAt ?? s?.t;
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return max > min ? (max - min) / 1000 : 0;
}

// 品質ゲート：そのエポックを収束判定に使えるか（停止用途のみ。記録の蓄積条件は変えない）
function qualityOk(epoch) {
  return epoch.fixMode === 3 && epoch.hdop != null && epoch.hdop <= 3 && epoch.satsUsed != null && epoch.satsUsed >= 5;
}

// エポックから保存用のサンプルを取り出す。
// 衛星リストも残す（保存後・読込後もスカイプロット / SNR を再現するため）。
// t は GPS時刻、recvAt は端末時計。Android 側は端末時計しか持たないため、
// 2系統の区間を突き合わせる共通の軸として recvAt も残す（js/survey.js）。
function toSample(epoch) {
  return {
    t: epoch.t ? epoch.t.getTime() : epoch.recvAt,
    recvAt: epoch.recvAt,
    lat: epoch.lat,
    lon: epoch.lon,
    altMSL: epoch.altMSL,
    fixQuality: epoch.fixQuality,
    fixMode: epoch.fixMode,
    satsUsed: epoch.satsUsed,
    satsInView: epoch.satsInView,
    pdop: epoch.pdop,
    hdop: epoch.hdop,
    vdop: epoch.vdop,
    latStd: epoch.latStd,
    lonStd: epoch.lonStd,
    speedKmh: epoch.speedKmh,
    course: epoch.course,
    satellites: (epoch.satellites || []).map((s) => ({
      sys: s.sys,
      prn: s.prn,
      elev: s.elev,
      azim: s.azim,
      snr: s.snr,
      used: s.used,
    })),
  };
}

// 集計値 → session.summary（一覧・エクスポート・停止サマリが読む形）。
// stats が無い（有効エポック0点）ときも stopReason だけは残す。
export function buildSummary({ stats, deviceStats, stopReason, autoStop, rxStats, rawLines, rawTruncated, bytes }) {
  const base = {
    count: stats?.count ?? 0,
    stopReason,
    autoStop,
    rxStats,
    rawLines,
    rawTruncated: rawTruncated || 0,
    // 端末内サイズ [バイト]。追記のたびに数えた概算値の合計（容量警告の材料）
    bytes: bytes || 0,
  };
  if (!stats) return base;
  return {
    ...base,
    lat: stats.center.lat,
    lon: stats.center.lon,
    altMSL: stats.altMean,
    drms: stats.drms,
    cep50: stats.cep50,
    cep95: stats.cep95,
    // 一覧で GNSS受信機 と並べて見せるための比較値
    ...(deviceStats ? { deviceDrms: deviceStats.drms, deviceCount: deviceStats.count } : {}),
  };
}

// 「データとして不足している」記録か（停止時に破棄を確認する条件）
export function isInsufficient({ durationSec, count }) {
  return durationSec >= INSUFFICIENT.minSec && count > 0 && count < INSUFFICIENT.minCount;
}

export class Recorder {
  constructor(storage, { onUpdate, onStop, onFlushError, getRxStats, deviceGnss } = {}) {
    this.storage = storage;
    this.onUpdate = onUpdate || (() => {}); // 収集中のライブ表示更新
    this.onStop = onStop || (() => {}); // 自動停止を含む停止通知（引数 = pending）
    this.onFlushError = onFlushError || (() => {}); // 追記の失敗通知（引数 = 連続失敗回数）
    this.getRxStats = getRxStats || null; // 受信品質統計の snapshot 提供元（app.js）
    this.deviceGnss = deviceGnss || null; // Android内蔵GNSS の並行取得（null 可）
    this.latestEpoch = null;
    this.current = null; // 収集中: { id, startedAt, samples, buf*, maxSec, maxEpochs, ... }
    this.finishing = null; // 停止時の書き込み（確定はこれを待ってから行う）
    this.stallTimer = null;
  }

  // 受信した NMEA 行を1本ずつ渡す（app.js の受信パイプラインから）。
  // 記録中かつ生NMEA保存が有効なときだけ蓄積する。チェックサムNG行・$PPICO も
  // 「受信したそのまま」を残す意味で区別せず入れる。
  addRawLine(line) {
    const rec = this.current;
    if (!rec || !rec.saveRaw) return;
    if (rec.rawCount >= MAX_RAW_LINES) {
      rec.rawTruncated++;
      return;
    }
    rec.rawCount++;
    rec.bufRaw.push({ t: Date.now(), line });
  }

  // 毎エポック呼ぶ。収集中なら fix のあるエポックを蓄積する。
  addEpoch(epoch) {
    this.latestEpoch = epoch;
    const rec = this.current;
    if (!rec) return;
    if (epoch.lat == null || epoch.lon == null || !(epoch.fixQuality > 0)) return;

    // 途絶判定の基準。fix を失っている間はここへ来ないので、fix 喪失も途絶として扱う
    rec.lastEpochAt = Date.now();

    const sample = toSample(epoch);
    rec.samples.push(sample); // 暫定集計に全件要るのでメモリにも残す
    rec.bufSamples.push(sample);
    rec.epochsSinceFlush++;

    const elapsedSec = (Date.now() - rec.startedAt) / 1000;
    const stats = computeStaticStats(rec.samples); // 暫定ばらつき（点数は高々数百なので毎回計算で十分軽い）
    // Android内蔵GNSS の暫定集計も同じ頻度で更新する（比較を記録中から見せるため）
    rec.deviceStats = rec.withDevice ? computeDeviceStats(rec.deviceSamples, stats?.center || null) : null;

    // 収束状況の算出（品質ゲート通過エポックのみ履歴に積む。不良で連続性リセット）
    let convergence = null;
    if (rec.autoStop) {
      if (qualityOk(epoch) && stats) {
        rec.convHistory.push({ t: elapsedSec, lat: stats.center.lat, lon: stats.center.lon, drms: stats.drms });
        // 古い履歴の間引き（基準点確保のため holdSec より 5 秒余裕を残す）
        const keepFrom = elapsedSec - CONVERGENCE.holdSec - 5;
        if (rec.convHistory[0].t < keepFrom) rec.convHistory = rec.convHistory.filter((h) => h.t >= keepFrom);
        convergence = evaluateConvergence(rec.convHistory, elapsedSec, { minSec: rec.minSec, ...CONVERGENCE });
      } else {
        rec.convHistory = []; // 品質不良 →「安定して10秒」の連続カウントをやり直す
      }
    }

    this.onUpdate({
      count: rec.samples.length,
      elapsedSec,
      stats,
      convergence,
      device: this._deviceInfo(),
      rawLines: rec.saveRaw ? rec.rawCount : null,
    });

    // まとまったら追記する。await しない（受信経路を待たせない）
    if (rec.epochsSinceFlush >= FLUSH_EPOCHS) this._flush(rec);

    // 収束停止（最低時間経過＋直近 holdSec 窓で中心・DRMS 横ばい）
    if (convergence && convergence.stable) {
      this.stop('converged');
      return;
    }

    // タイムアウト停止（0 は無効）
    if (rec.maxSec > 0 && elapsedSec >= rec.maxSec) {
      this.stop('timeout');
    } else if (rec.maxEpochs > 0 && rec.samples.length >= rec.maxEpochs) {
      this.stop('maxEpochs');
    }
  }

  get isRecording() {
    return !!this.current;
  }

  // 収集中の下書き id（記録一覧でその行の操作を止めるために使う）
  get currentId() {
    return this.current?.id ?? null;
  }

  // Android内蔵GNSS の 1 サンプル（device-gnss.js → app.js 経由。収集中のみ蓄積する）
  addDeviceSample(sample) {
    const rec = this.current;
    if (!rec || !rec.withDevice) return;
    if (sample?.lat == null || sample.lon == null) return;
    rec.deviceSamples.push(sample);
    rec.bufDevice.push(sample);
  }

  // 収集状況表示用（記録タブの散布図凡例）。並行取得していなければ null。
  // spanSec は内蔵が実際にデータを返していた長さ。GNSS受信機の 1Hz と違って
  // OS が更新を間引くため、点数だけでは「何秒ぶんか」が分からない（仕様 1）。
  _deviceInfo() {
    const rec = this.current;
    if (!rec?.withDevice) return null;
    return {
      status: this.deviceGnss.status,
      count: rec.deviceSamples.length,
      spanSec: spanSecOf(rec.deviceSamples),
      stats: rec.deviceStats,
    };
  }

  // ---- 追記（5 エポックごと） ----

  // バッファを 1 チャンクとして書き出す。**await しない**で呼ぶこと。
  // 失敗したぶんはバッファへ戻し、次のチャンクにまとめて再試行する。
  _flush(rec) {
    const hasRaw = rec.saveRaw && rec.bufRaw.length > 0;
    if (!rec.bufSamples.length && !rec.bufDevice.length && !hasRaw) return null;

    const data = { samples: rec.bufSamples.slice() };
    if (rec.saveRaw) data.rawNmea = rec.bufRaw.slice();
    if (rec.bufDevice.length) data.deviceSamples = rec.bufDevice.slice();
    rec.bufSamples.length = 0;
    rec.bufRaw.length = 0;
    rec.bufDevice.length = 0;
    rec.epochsSinceFlush = 0;

    // 端末内サイズはここで数える。停止時に測ろうとすると書き終えたチャンクを
    // 読み戻すことになるので、手元にあるうちに数えておく（20KB の JSON 化は誤差の範囲）。
    // IndexedDB の実使用量そのものではなく、容量警告に使える程度の概算値。
    rec.bytes += JSON.stringify(data).length;

    const progress = {
      endedAt: Date.now(),
      summary: {
        count: rec.samples.length,
        rawLines: rec.saveRaw ? rec.rawCount : null,
        deviceCount: rec.deviceSamples.length,
        bytes: rec.bytes,
      },
    };
    return this.storage.appendChunk(rec.id, rec.seq++, data, progress).then(
      () => {
        rec.flushFailures = 0;
      },
      (e) => {
        // 収集済みのぶんを捨てない。新しく積まれたデータの前へ戻す（時系列を保つ）
        rec.bufSamples.unshift(...data.samples);
        if (data.rawNmea) rec.bufRaw.unshift(...data.rawNmea);
        if (data.deviceSamples) rec.bufDevice.unshift(...data.deviceSamples);
        rec.flushFailures++;
        this.onFlushError(rec.flushFailures, e);
        // 書けない状態で取り続けても残せない。打ち切って下書きとして回収させる
        if (rec.flushFailures >= MAX_FLUSH_FAILURES && this.current === rec) this.stop('storageError');
      }
    );
  }

  // ---- record ----
  // 下書きを作ってから収集を始める。作れなければ記録しない（残せない記録は始めない）。
  async start({ maxSec = 60, maxEpochs = 120, autoStop = true, minSec = 30, withDevice = false, saveRaw = true } = {}) {
    if (this.current) return null;
    const startedAt = Date.now();
    const id = `rec_${startedAt}`;
    const surveyId = surveyIdOf(startedAt);
    await this.storage.createDraft({ id, startedAt, surveyId }); // 失敗は呼び出し側へ投げる

    this.current = {
      id,
      surveyId,
      startedAt,
      lastEpochAt: startedAt, // 途絶判定の起点
      samples: [],
      deviceSamples: [], // Android内蔵GNSS のサンプル（受信機とはレートも点数も揃わない）
      bufSamples: [], // 次のチャンクへ入れるぶん（フラッシュで空にする）
      bufRaw: [],
      bufDevice: [],
      seq: 0, // チャンクの通し番号
      bytes: 0, // 書き出した実データの概算バイト数（容量警告用）
      epochsSinceFlush: 0,
      flushFailures: 0,
      maxSec,
      maxEpochs,
      autoStop, // 収束自動停止の有効/無効
      minSec, // 最低収集時間 [秒]（これ未満では絶対に停止しない）
      convHistory: [], // [{ t, lat, lon, drms }] 品質ゲート通過エポックのみ
      rxStart: this.getRxStats ? this.getRxStats() : null, // 受信品質の測定開始時点
      saveRaw, // 生NMEA行も残すか（設定 saveRawNmea）
      rawCount: 0, // 受け入れた生NMEA行数（配列は持たないので数だけ数える）
      rawTruncated: 0, // 上限超過で捨てた行数
      withDevice: withDevice && !!this.deviceGnss, // Android内蔵GNSS を並行取得するか
      deviceStats: null,
    };
    if (this.current.withDevice) this.deviceGnss.start();
    this._startStallTimer();
    this.onUpdate({
      count: 0,
      elapsedSec: 0,
      stats: null,
      convergence: null,
      device: this._deviceInfo(),
      rawLines: saveRaw ? 0 : null,
    });
    return this.current.id;
  }

  // データが届かなくなったら打ち切る。停止判定は addEpoch の中にしか無いため、
  // エポックが来なくなると記録が凍る（それを防ぐのがこのタイマー）。
  _startStallTimer() {
    this._stopStallTimer();
    this.stallTimer = setInterval(() => {
      const rec = this.current;
      if (rec && Date.now() - rec.lastEpochAt > STALL_MS) this.stop('stalled');
    }, 1000);
  }

  _stopStallTimer() {
    if (this.stallTimer != null) clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  // ---- stop ----
  // 収集を止めて集計し、「未確定の記録」を返す。DB への書き込みは描画の後に走らせる
  // （await しない）。確定は書き込みの完了を待ってから行う（settled()）。
  // reason: 'converged' | 'timeout' | 'maxEpochs' | 'manual' | 'stalled' | 'storageError'
  stop(reason = 'manual') {
    const rec = this.current;
    if (!rec) return null;
    this.current = null;
    this._stopStallTimer();
    // 状態は watch を止める前に控える（stop() で idle に戻るため）。
    // 1点も取れなかった理由（未許可・非対応など）を停止後の表示にも残す。
    const deviceStatus = rec.withDevice ? this.deviceGnss.status : null;
    if (rec.withDevice) this.deviceGnss.stop();

    const stats = computeStaticStats(rec.samples);
    const deviceStats = rec.withDevice ? computeDeviceStats(rec.deviceSamples, stats?.center || null) : null;
    const endedAt = Date.now();
    const window = buildWindow({
      startedAt: rec.startedAt,
      endedAt,
      samples: rec.samples,
      deviceSamples: rec.deviceSamples,
    });
    const summary = buildSummary({
      stats,
      deviceStats,
      stopReason: reason,
      autoStop: rec.autoStop,
      // この測定区間の受信品質（開始時点との差分）。取りこぼし確認用。
      rxStats: this.getRxStats ? diffRxStats(this.getRxStats(), rec.rxStart) : null,
      rawLines: rec.saveRaw ? rec.rawCount : null,
      rawTruncated: rec.rawTruncated,
      bytes: rec.bytes,
    });

    const pending = {
      sessionId: rec.id,
      surveyId: rec.surveyId,
      stats,
      summary,
      window,
      // Android内蔵GNSS の比較値（GNSS受信機の中心を基準にズレを出す）
      deviceStats,
      deviceStatus,
      deviceSpanSec: spanSecOf(rec.deviceSamples),
      startedAt: rec.startedAt,
      endedAt,
      stopReason: reason,
      // 収束判定を働かせていたか。停止サマリで「未収束」と「収束判定なし」を
      // 書き分けるのに要る（自動停止 OFF のときは未収束ではない。仕様 2）。
      autoStop: rec.autoStop,
      rxStats: summary.rxStats,
    };
    this.onStop(pending);
    // 描画の後に書く。1.6MB を一度に、ではなく残りのバッファぶんだけなので軽い
    this.finishing = this._finish(rec, { stats, deviceStats, summary, window, endedAt });
    return pending;
  }

  async _finish(rec, meta) {
    try {
      // 有効エポックが 0 点なら復元しても使えない。下書きごと片付ける
      if (!meta.stats) {
        await this.storage.deleteSession(rec.id);
        return;
      }
      await this._flush(rec); // 5 エポック未満の端数もそのまま書く
      await this.storage.finishDraft(rec.id, meta);
    } catch (e) {
      this.onFlushError(rec.flushFailures + 1, e);
    }
  }

  // 停止時の書き込みが終わるのを待つ（確定・破棄の前に呼ぶ）
  async settled() {
    try {
      await this.finishing;
    } catch (_) {
      // 失敗は onFlushError で通知済み。確定は続行させる（書けているぶんは残っている）
    }
  }
}
