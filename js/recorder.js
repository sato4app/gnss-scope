// 記録（record → stop → save）。静止点に留まって連続エポックを収集し、
// 停止時に「ばらつき（DRMS / CEP / 散布図）」を集計する。
//   record: 収集開始。autoStop 有効時は「最低 minSec 秒 → 中心・DRMS が holdSec 秒横ばい」で
//           自動停止する（docs/algospec-202607.md 3.）。maxSec/maxEpochs はタイムアウト（保険）。
//   stop:   収集停止。集計結果を「未保存の記録（pending）」として返すだけで DB には書かない。
//   save:   ラベル・メモを付けて IndexedDB（storage.js）へ保存する。
// 集計は accuracy.js の computeStaticStats。測定区間の受信品質（rxStats）も
// summary に残す（docs/algospec-202607.md 5.）。
//
// 1地点の記録で 2 系統を同時に集める（仕様 4-8）:
//   M10S   生NMEA行（rawNmea）＋ パース済みエポック（samples）
//   Android 端末内蔵GNSS の測位（deviceSamples）
// どちらも同じ point レコードへ入れ、地点番号（surveyId + pointNo）を付けて保存するので、
// 1日に何十地点まわっても「どの NMEA とどの Android データが対か」は後から必ず辿れる。
// 2系統が本当に同じ時間に取れていたかは window.overlap で検証する（js/survey.js）。
// 記録タブの UI 配線（ボタン・表示）は record-ui.js 側。
import { computeStaticStats, computeDeviceStats, evaluateConvergence } from './accuracy.js';
import { diffRxStats } from './stream-stats.js';
import { buildWindow, nextPointNo, pointLabel, surveyIdOf } from './survey.js';

// 収束自動停止の判定パラメータ（設定画面には出さないモジュール定数）
const CONVERGENCE = { holdSec: 10, centerTolM: 0.3, drmsTolAbsM: 0.3, drmsTolPct: 0.05 };

// 生NMEA行の上限（保険）。maxSec=0（無制限）で走らせ続けても端末を圧迫しないようにする。
// 1Hz で 10〜20 行/秒なので、20000 行 ≈ 20〜30 分ぶん（約 1.6 MB）。
// 打ち切った場合は rawTruncated に本数を残し、記録が途中までであることを隠さない。
const MAX_RAW_LINES = 20000;

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

export class Recorder {
  constructor(storage, { onUpdate, onStop, getRxStats, deviceGnss } = {}) {
    this.storage = storage;
    this.onUpdate = onUpdate || (() => {}); // 収集中のライブ表示更新
    this.onStop = onStop || (() => {}); // 自動停止を含む停止通知（引数 = pending）
    this.getRxStats = getRxStats || null; // 受信品質統計の snapshot 提供元（app.js）
    this.deviceGnss = deviceGnss || null; // 端末内蔵GNSS の並行取得（null 可）
    this.latestEpoch = null;
    this.current = null; // 収集中: { startedAt, samples, rawNmea, maxSec, maxEpochs, paused, ... }
  }

  // 受信した NMEA 行を1本ずつ渡す（app.js の受信パイプラインから）。
  // 記録中かつ生NMEA保存が有効なときだけ蓄積する。チェックサムNG行・$PPICO も
  // 「受信したそのまま」を残す意味で区別せず入れる。
  addRawLine(line) {
    const rec = this.current;
    if (!rec || rec.paused || !rec.saveRaw) return;
    if (rec.rawNmea.length >= MAX_RAW_LINES) {
      rec.rawTruncated++;
      return;
    }
    rec.rawNmea.push({ t: Date.now(), line });
  }

  // 毎エポック呼ぶ。収集中なら fix のあるエポックを蓄積する。
  addEpoch(epoch) {
    this.latestEpoch = epoch;
    const rec = this.current;
    if (!rec || rec.paused) return;
    if (epoch.lat == null || epoch.lon == null || !(epoch.fixQuality > 0)) return;

    rec.samples.push(toSample(epoch));
    const elapsedSec = (Date.now() - rec.startedAt) / 1000;
    const stats = computeStaticStats(rec.samples); // 暫定ばらつき（点数は高々数百なので毎回計算で十分軽い）
    // 端末内蔵GNSS の暫定集計も同じ頻度で更新する（比較を記録中から見せるため）
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
      rawLines: rec.saveRaw ? rec.rawNmea.length : null,
    });

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

  // 画面非表示中は収集を一時停止する（BLE も切れるため。仕様 3-7）
  setPaused(paused) {
    if (!this.current) return;
    this.current.paused = paused;
    if (this.current.withDevice) this.deviceGnss.setPaused(paused);
  }

  // 端末内蔵GNSS の 1 サンプル（device-gnss.js → app.js 経由。収集中のみ蓄積する）
  addDeviceSample(sample) {
    const rec = this.current;
    if (!rec || rec.paused || !rec.withDevice) return;
    if (sample?.lat == null || sample.lon == null) return;
    rec.deviceSamples.push(sample);
  }

  // 収集状況表示用（記録タブの「端末内蔵GNSS」行）。並行取得していなければ null。
  _deviceInfo() {
    const rec = this.current;
    if (!rec?.withDevice) return null;
    return { status: this.deviceGnss.status, count: rec.deviceSamples.length, stats: rec.deviceStats };
  }

  // ---- record ----
  start({ maxSec = 60, maxEpochs = 120, autoStop = true, minSec = 30, withDevice = false, saveRaw = true } = {}) {
    if (this.current) return;
    this.current = {
      startedAt: Date.now(),
      samples: [],
      maxSec,
      maxEpochs,
      paused: false,
      autoStop, // 収束自動停止の有効/無効
      minSec, // 最低収集時間 [秒]（これ未満では絶対に停止しない）
      convHistory: [], // [{ t, lat, lon, drms }] 品質ゲート通過エポックのみ
      rxStart: this.getRxStats ? this.getRxStats() : null, // 受信品質の測定開始時点
      saveRaw, // 生NMEA行も残すか（設定 saveRawNmea）
      rawNmea: [], // [{ t, line }] 受信した NMEA 行そのもの
      rawTruncated: 0, // 上限超過で捨てた行数
      withDevice: withDevice && !!this.deviceGnss, // 端末内蔵GNSS を並行取得するか
      deviceSamples: [], // 端末内蔵GNSS のサンプル（M10S とはレートも点数も揃わない）
      deviceStats: null,
    };
    if (this.current.withDevice) this.deviceGnss.start();
    this.onUpdate({
      count: 0,
      elapsedSec: 0,
      stats: null,
      convergence: null,
      device: this._deviceInfo(),
      rawLines: saveRaw ? 0 : null,
    });
  }

  // ---- stop ----
  // 収集を止めて集計する。DB へは書かず「未保存の記録」を返す（保存は save()）。
  stop(reason = 'manual') {
    const rec = this.current;
    if (!rec) return null;
    this.current = null;
    if (rec.withDevice) this.deviceGnss.stop();

    const stats = computeStaticStats(rec.samples);
    const endedAt = Date.now();
    const pending = {
      stats,
      samples: rec.samples,
      // 生NMEA行（保存 OFF なら null。空配列と「取っていない」を区別する）
      rawNmea: rec.saveRaw ? rec.rawNmea : null,
      rawTruncated: rec.rawTruncated,
      // 端末内蔵GNSS の比較値（M10S の中心を基準にズレを出す）
      deviceSamples: rec.deviceSamples,
      deviceStats: rec.withDevice ? computeDeviceStats(rec.deviceSamples, stats?.center || null) : null,
      startedAt: rec.startedAt,
      endedAt,
      // 2系統それぞれの実測区間と、その重なり（地点の対応を後から検証するため）
      window: buildWindow({
        startedAt: rec.startedAt,
        endedAt,
        samples: rec.samples,
        deviceSamples: rec.deviceSamples,
      }),
      stopReason: reason, // 'converged' | 'timeout' | 'maxEpochs' | 'manual'
      // この測定区間の受信品質（開始時点との差分）。取りこぼし確認用。
      rxStats: this.getRxStats ? diffRxStats(this.getRxStats(), rec.rxStart) : null,
    };
    this.onStop(pending);
    return pending;
  }

  // ---- save ----
  // 未保存の記録に地点名・メモを付けて IndexedDB へ保存する。
  // 保存時に調査日（surveyId）と同日連番（pointNo）を採番し、ツリーの根 surveys も用意する。
  async save(pending, { label = '', memo = '' } = {}) {
    if (!pending) throw new Error('保存する記録がありません');
    const st = pending.stats;
    const dst = pending.deviceStats;

    const surveyId = surveyIdOf(pending.startedAt);
    const pointNo = nextPointNo(await this.storage.getSessionsBySurvey(surveyId), surveyId);
    await this.storage.ensureSurvey(surveyId, pending.startedAt);

    const id = `rec_${pending.startedAt}`;
    const session = {
      id,
      type: 'record',
      surveyId, // ツリーの根（調査日）への参照
      pointNo, // 同じ調査日の中での地点番号
      label: label || pointLabel(surveyId, pointNo),
      memo,
      createdAt: pending.startedAt,
      endedAt: pending.endedAt,
      window: pending.window, // 2系統の測定区間と重なり（地点の対応の検証用）
      summary: st
        ? {
            lat: st.center.lat,
            lon: st.center.lon,
            altMSL: st.altMean,
            count: st.count,
            drms: st.drms,
            cep50: st.cep50,
            cep95: st.cep95,
            stopReason: pending.stopReason,
            rxStats: pending.rxStats,
            rawLines: pending.rawNmea ? pending.rawNmea.length : null,
            rawTruncated: pending.rawTruncated || 0,
            // 一覧で M10S と並べて見せるための比較値
            ...(dst ? { deviceDrms: dst.drms, deviceCount: dst.count } : {}),
          }
        : {
            count: 0,
            stopReason: pending.stopReason,
            rxStats: pending.rxStats,
            rawLines: pending.rawNmea ? pending.rawNmea.length : null,
            rawTruncated: pending.rawTruncated || 0,
          },
    };
    const point = {
      id: `${id}_p`,
      sessionId: id,
      surveyId, // 葉からも調査日・地点番号が分かるようにする（エクスポート先でも同じ）
      pointNo,
      kind: 'record',
      stats: st, // 集計値（中心・標準偏差・DRMS・CEP・散布図オフセット等）
      samples: pending.samples, // 生エポック群（衛星リスト込み）
    };
    // 生NMEA行は取ったときだけ足す（OFF の記録の形は従来どおり）
    if (pending.rawNmea) point.rawNmea = pending.rawNmea;
    // 端末内蔵GNSS を取れたときだけ足す
    if (dst) {
      point.deviceSamples = pending.deviceSamples;
      point.deviceStats = dst;
    }
    await this.storage.putSession(session);
    await this.storage.putPoint(point);
    return { session, point };
  }
}
