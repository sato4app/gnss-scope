// 記録タブの収集フロー：record → stop → save。
//   record: 下書きを作って収集を開始（Wake Lock 取得）
//   stop:   収集停止 → 集計を表示。下書きには書き終わっている
//   save:   地点名・メモを付けて確定 → そのまま読込データにする
// 収集中のライブ表示・進捗バー・散布図・凡例もこのモジュールが持つ。
// 記録中の画面維持（Wake Lock）は記録の一部なのでここに含める（仕様 3-7）。
// 保存済みの記録の一覧・編集・エクスポートは session-list-ui.js、
// 写真の取り込みは photo-ui.js が担当する。
//
// 画面に出す情報は重複させない（仕様 7）。同じ値の置き場所は1か所だけ:
//   点数・DRMS      → 散布図の下の凡例（renderLegend）
//   経過・収束の状況 → 進捗バー（renderProgress）
//   停止した理由     → 測位結果の見出し（stopSummaryText）
//   それ以外の明細   → 測位結果を開いた中（formatResult）
import {
  $, fmt, satsText, escapeMarkup, formatResult, renderOutside,
  sessionMeta, stopSummaryText,
} from './view-utils.js';
import { isInsufficient } from './recorder.js';
import { ScatterPlotView } from './charts.js';
import { deviceStatusText } from './device-gnss.js';
import { Beeper, beepFor } from './beep.js';
import { SERIES } from './constants.js';
import { initPhotoUI } from './photo-ui.js';
import { initSessionListUI } from './session-list-ui.js';

// 収束判定の窓 [秒]（recorder.js の CONVERGENCE.holdSec と揃える。副バーの分母）
const HOLD_SEC = 10;

export function initRecordUI({ recorder, storage, settings, onLoad, getLoadedId }) {
  const scatterView = new ScatterPlotView($('rec-scatter'));
  const beeper = new Beeper(() => settings.beep);
  const wakeLock = new WakeLockManager((msg) => {
    $('wakelock-state').textContent = `Wake Lock: ${msg}`;
  });
  let pending = null; // 停止直後の下書き（DB には書けている）
  let latestEpoch = null; // 進捗バー脇の品質表示（衛星数・HDOP）用
  let prevStableSec = 0; // 安定カウントが 0 に戻ったことを見せるため直前値を持つ

  const photos = initPhotoUI({ storage, settings });
  const list = initSessionListUI({
    storage,
    recorder,
    photos,
    onLoad,
    getLoadedId,
    getPendingId: () => pending?.sessionId ?? null,
    onPendingGone: () => clearPending(),
  });

  function setRecordingUi(on) {
    $('btn-record').disabled = on;
    $('btn-stop').disabled = !on;
    $('rec-progress').hidden = !on;
    $('rec-dot').hidden = !on;
    // 記録中は現在の測位値を畳んで、進捗と散布図に画面を譲る
    $('rc-fix-box').open = !on;
  }

  function setPendingUi(on) {
    $('save-form').hidden = !on;
    $('btn-save').disabled = !on;
    $('btn-discard').disabled = !on;
  }

  // 未確定の記録を手放す（確定・破棄・一覧からの削除で共用）
  function clearPending() {
    pending = null;
    setPendingUi(false);
    $('photo-strip').innerHTML = '';
  }

  // 記録中の追記が失敗したことを隠さない（黙って握り潰さない）
  function showWriteError(text) {
    const el = $('rec-write-error');
    el.hidden = !text;
    el.textContent = text || '';
  }

  // 停止直後の保存フォームの写真パネル（現地にいるうちに写真を付けられるようにする）
  photos.wirePanel({
    boxEl: $('photo-box-save'),
    addBtn: $('btn-photo-add'),
    stripEl: $('photo-strip'),
    countEl: $('photo-count'),
    getSessionId: () => pending?.sessionId ?? null,
    onChange: async () => {
      await list.refresh();
      await list.refreshStorageWarning();
    },
  });

  // ---- record ----
  $('btn-record').addEventListener('click', async () => {
    if (recorder.isRecording) return;
    const epoch = recorder.latestEpoch;
    if (!epoch || epoch.lat == null) {
      alert('有効な測位データがありません。接続（またはモックNMEA配信）を開始してください。');
      return;
    }
    // 下書きは残っているので破棄の確認はしない（一覧から確定・削除できる）
    clearPending();
    showWriteError('');
    $('rec-result-box').hidden = true;
    $('rec-scatter-box').hidden = false; // ここから散布図を出す（記録前は出さない。仕様 6）
    prevStableSec = 0;
    scatterView.clear(); // 表示半径のヒステリシスも記録ごとに引き継がない
    // 自動再生ポリシーのため、AudioContext はこのクリックの中で用意する（仕様 2）
    beeper.unlock();
    $('btn-record').disabled = true; // 下書き作成の待ち時間に二度押しさせない
    try {
      // 下書きを作ってから収集を始める。作れなければ記録しない（残せない記録は始めない）
      await recorder.start({
        maxSec: settings.maxSec,
        maxEpochs: settings.maxEpochs,
        autoStop: settings.autoStop,
        minSec: settings.minSec,
        withDevice: settings.deviceGnss, // Android内蔵GNSS の並行取得（比較用）
        saveRaw: settings.saveRawNmea, // 生NMEA行もそのまま残すか
      });
    } catch (e) {
      $('btn-record').disabled = false;
      alert(`記録を開始できませんでした（下書きを作れません）: ${e.message}`);
      return;
    }
    setRecordingUi(true);
    await wakeLock.acquire(); // 記録中は画面を維持
    await list.refresh();
  });

  // ---- stop ----（手動。自動停止は recorder 側から onRecordStop で入る）
  $('btn-stop').addEventListener('click', () => {
    if (recorder.isRecording) recorder.stop('manual');
  });

  // 収集中の1エポックごと（app.js から recorder.onUpdate 経由で配られる）
  function onRecordUpdate({ count, elapsedSec, stats, convergence, device }) {
    renderProgress(elapsedSec, convergence);
    const outside = stats ? scatterView.update(stats, device?.stats || null) : null;
    renderLegend({ count, spanSec: elapsedSec, stats }, device, outside);
  }

  // 記録中の追記が失敗したとき（連続 3 回で recorder が打ち切る）
  function onWriteError(failures) {
    showWriteError(`書き込みに失敗しました（${failures}回目）`);
  }

  // ---- 散布図の凡例（系統名・実測区間・点数・DRMS。仕様 1） ----
  // 点数だけを並べると「内蔵は点が少ない＝劣る」と読めてしまう。実際は
  // 受信機が 1Hz なのに対し内蔵は OS が更新を間引くだけなので、秒数と併記する。
  // gnss/dev は { count, spanSec, stats, status } 。dev が null なら取得OFF。
  function renderLegend(gnss, dev, outside) {
    $('rec-legend').innerHTML = [
      seriesRow(SERIES.gnss, gnss, true),
      seriesRow(SERIES.device, dev, false),
    ].join('');
    renderOutside($('rec-outside'), outside);
  }

  function seriesRow(series, info, filled) {
    // 塗り＝GNSS受信機 / 中抜き＝Android内蔵（色だけに頼らず形でも区別する）
    const style = filled ? `background:${series.color}` : `border-color:${series.color}`;
    return `<span class="item"><i class="mark" style="${style}"></i>` +
      `<span class="name">${series.label}</span>${escapeMarkup(seriesValueText(info))}</span>`;
  }

  function seriesValueText(info) {
    if (!info) return ' — 取得OFF（設定で有効にできます）';
    // 1点も来ていない = 許可待ち / 拒否 / 非対応。状態をそのまま出す
    if (!info.count) return info.status ? ` — ${deviceStatusText(info.status)}` : ' — 0点';
    const span = `${Math.round(info.spanSec || 0)}秒間 ${info.count}点`;
    return ` ${span}  DRMS ${fmt(info.stats?.drms, 2, 'm')}`;
  }

  // ---- 収束の進捗バー（仕様 8） ----
  // 主バー: 経過 / 上限時間（あと何秒立っていればよいか）＋ 最低時間のマーカー
  // 副バー: フェーズ1「連続良好データ n/10秒」→ 満タン後はフェーズ2「判定中」に切り替え、
  //         中心移動・DRMS幅の達成度を出す。窓が溜まっても中心が動いていれば止まらないため、
  //         バーが満タンのまま待たされる状態を「判定中」として見せる必要がある。
  function renderProgress(elapsedSec, convergence) {
    const maxSec = settings.maxSec;
    $('prog-elapsed').style.width = maxSec > 0 ? `${Math.min(elapsedSec / maxSec, 1) * 100}%` : '0';
    $('prog-elapsed-val').textContent =
      maxSec > 0 ? `${Math.floor(elapsedSec)} / ${maxSec}s` : `${Math.floor(elapsedSec)}s（上限なし）`;
    const mark = $('prog-minmark');
    mark.hidden = !(maxSec > 0 && settings.minSec > 0 && settings.minSec < maxSec);
    if (!mark.hidden) mark.style.left = `${(settings.minSec / maxSec) * 100}%`;

    renderStableRow(elapsedSec, convergence);
    $('prog-quality').textContent = qualityText();
  }

  function renderStableRow(elapsedSec, convergence) {
    const row = $('prog-stable-row');
    const judge = $('prog-judge');
    if (!settings.autoStop) {
      row.hidden = true;
      judge.hidden = true;
      return;
    }
    row.hidden = false;
    const bar = $('prog-stable');
    const stableSec = convergence?.stableSec || 0;
    // 最低収集時間に届くまでは、そもそも収束しても停止しない
    if (elapsedSec < settings.minSec) {
      $('prog-stable-name').textContent = '最低時間';
      bar.className = '';
      bar.style.width = `${Math.min(elapsedSec / settings.minSec, 1) * 100}%`;
      $('prog-stable-val').textContent = `残り ${Math.max(0, Math.ceil(settings.minSec - elapsedSec))}s`;
      judge.hidden = true;
      prevStableSec = stableSec;
      return;
    }

    if (convergence?.windowReady) {
      // フェーズ2：窓は溜まった。あとは中心・DRMS が許容内へ落ち着くのを待つ
      $('prog-stable-name').textContent = '判定中';
      bar.className = 'ok';
      bar.style.width = '100%';
      $('prog-stable-val').textContent = `安定 ${stableSec.toFixed(0)}s`;
      judge.hidden = false;
      renderJudge('center', convergence.centerMoveM, convergence.centerTolM, 2);
      renderJudge('drms', convergence.drmsRangeM, convergence.drmsTolM, 2);
    } else {
      // フェーズ1：品質の良いエポックが連続 HOLD_SEC 秒たまるのを待つ。
      // 品質不良でリセットされるとバーは戻る。赤く出して「戻った」ことを分かるようにする。
      $('prog-stable-name').textContent = '安定待ち';
      bar.className = stableSec < prevStableSec ? 'reset' : '';
      bar.style.width = `${Math.min(stableSec / HOLD_SEC, 1) * 100}%`;
      $('prog-stable-val').textContent = `${stableSec.toFixed(0)} / ${HOLD_SEC}s`;
      judge.hidden = true;
    }
    prevStableSec = stableSec;
  }

  // 判定ゲージ（実測値 / 許容値）。許容内なら緑。
  function renderJudge(key, value, tol, digits) {
    const bar = $(`judge-${key}`);
    const ok = value != null && tol > 0 && value <= tol;
    bar.className = ok ? 'ok' : '';
    bar.style.width = value != null && tol > 0 ? `${Math.min(value / tol, 1) * 100}%` : '0';
    $(`judge-${key}-val`).textContent =
      value == null ? '—' : `${value.toFixed(digits)} / ${tol.toFixed(digits)}m`;
  }

  // 収束判定の品質ゲート条件（recorder.js の qualityOk）。止まらない理由の手掛かりになる
  function qualityText() {
    if (!latestEpoch) return '—';
    const mode = latestEpoch.fixMode === 3 ? '3D' : latestEpoch.fixMode === 2 ? '2D' : 'No fix';
    return `衛星 ${satsText(latestEpoch)}　HDOP ${fmt(latestEpoch.hdop)}　${mode}`;
  }

  // 停止（手動・自動とも）。この時点で下書きへの書き込みは走っている（await しない）。
  async function onRecordStop(result) {
    pending = result;
    setRecordingUi(false);
    await wakeLock.release();

    // 収束＝短く2回 / 打ち切り＝長く1回。手動停止は鳴らさない（仕様 2）
    const sound = beepFor(result.stopReason);
    if (sound) beeper.play(sound);

    const outside = scatterView.update(pending.stats, pending.deviceStats || null);
    renderLegend(
      { count: pending.stats?.count || 0, spanSec: pending.window?.gnss?.durationSec, stats: pending.stats },
      pending.deviceStatus == null
        ? null
        : {
            count: pending.deviceStats?.count || 0,
            spanSec: pending.deviceSpanSec,
            stats: pending.deviceStats,
            status: pending.deviceStatus,
          },
      outside
    );
    const durationSec = (pending.endedAt - pending.startedAt) / 1000;
    showResult(
      stopSummaryText({
        stopReason: pending.stopReason,
        durationSec,
        count: pending.stats?.count || 0,
        autoStop: pending.autoStop,
      }),
      formatResult({
        meta: { label: '未確定の記録', rxStats: pending.rxStats },
        stats: pending.stats,
        deviceStats: pending.deviceStats,
        window: pending.window,
        summary: pending.summary,
      }),
      pending.stopReason
    );

    if (!pending.stats) {
      // 0点の記録は recorder 側が下書きごと片付ける
      clearPending();
      await recorder.settled();
      await list.refresh();
      return;
    }

    // データ不足なら破棄を確認する（結果を見てから判断できるよう、描画の後に出す）。
    // 下書きは書けているので、答えないまま放置しても失われない。
    if (isInsufficient({ durationSec, count: pending.stats.count })) {
      const msg = `${Math.round(durationSec)}秒間で${pending.stats.count}点しか取得できていません。` +
        'データとして不足しています。破棄しますか？';
      if (confirm(msg)) {
        await discardPending();
        return;
      }
    }

    // 既定の地点名は yyyy-mm-dd-xx（調査日 ＋ 同日連番）。確定済みだけを数えて採番する。
    $('rec-label').value = await list.defaultLabel(pending.surveyId);
    $('rec-memo').value = '';
    setPendingUi(true);
    await photos.render($('photo-strip'), $('photo-count'), pending.sessionId);
    await recorder.settled(); // 一覧に完全な集計値を出すため、書き込みの完了を待つ
    await list.refresh();
    await list.refreshStorageWarning();
  }

  // 測位結果：見出し＝停止条件だけ（仕様 3）、中身＝明細。
  // 開閉状態は触らない。一度開いたら同じ調査中は開いたままになる。
  function showResult(summaryText, detailText, stopReason) {
    const summary = $('rec-stop-summary');
    summary.textContent = summaryText;
    summary.classList.toggle('warn', !!stopReason && stopReason !== 'converged');
    $('rec-result').textContent = detailText;
    $('rec-result-box').hidden = false;
  }

  // ---- save（＝確定） ----
  $('btn-save').addEventListener('click', async () => {
    if (!pending) return;
    try {
      await recorder.settled(); // 停止時の書き込みが終わってから確定する
      const entry = await list.confirmDraft(
        await storage.getSession(pending.sessionId),
        $('rec-label').value.trim(),
        $('rec-memo').value.trim()
      );
      if (!entry) return;
      clearPending();
      const meta = sessionMeta(entry.session);
      showResult(stopSummaryText(meta), list.savedText(entry.session, entry.point), meta.stopReason);
      await list.load(entry); // 確定した記録をそのまま解析・地図の対象にする
    } catch (e) {
      alert(`保存に失敗しました: ${e.message}`);
    }
  });

  // ---- 破棄 ----
  $('btn-discard').addEventListener('click', async () => {
    if (!pending) return;
    if (!confirm('この記録を破棄しますか？（元に戻せません）')) return;
    await discardPending();
  });

  async function discardPending() {
    const id = pending?.sessionId;
    clearPending();
    if (!id) return;
    await recorder.settled();
    await storage.deleteSession(id);
    if (id === getLoadedId()) await list.load(null);
    else await list.refresh();
    await list.refreshStorageWarning();
  }

  // ---- 現在の測位値（記録していない間も表示する） ----
  function update(epoch, acc) {
    latestEpoch = epoch; // 進捗バー脇の品質表示にも使う
    $('rc-lat').textContent = epoch.lat != null ? epoch.lat.toFixed(7) : '—';
    $('rc-lon').textContent = epoch.lon != null ? epoch.lon.toFixed(7) : '—';
    $('rc-alt').textContent = fmt(epoch.altMSL, 1, ' m');
    $('rc-acc').textContent = acc ? `±${acc.value.toFixed(1)} m (${acc.source})` : '—';
    $('rc-sats').textContent = satsText(epoch);
    $('rc-hdop').textContent = fmt(epoch.hdop);
  }

  setRecordingUi(false);
  setPendingUi(false);

  return {
    update,
    onRecordUpdate,
    onRecordStop,
    onWriteError,
    refreshStorageWarning: list.refreshStorageWarning,
    // 写真の上限枚数を 0 にすると写真UIごと消える。設定タブから変えられるので、
    // 保存フォームと一覧の編集フォーム（refresh で作り直す）に反映し直す。
    refreshPhotoUi: async () => {
      $('photo-box-save').hidden = !photos.isEnabled();
      await list.refresh();
    },
    onShow: () => scatterView.redraw(),
  };
}

// ---- Wake Lock（記録中の画面維持） ----
// 画面復帰（visibilitychange）で自動再取得する。
// BLE はバックグラウンドで切れるため「記録は画面表示中のみ有効」。
class WakeLockManager {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.lock = null;
    this.wanted = false; // acquire 済みで保持し続けたいか
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') this._request();
    });
  }

  async acquire() {
    this.wanted = true;
    await this._request();
  }

  async _request() {
    if (!('wakeLock' in navigator)) {
      this.onChange('非対応');
      return;
    }
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => {
        this.lock = null;
        this.onChange(this.wanted ? '解除（画面復帰で再取得）' : '解除');
      });
      this.onChange('取得中');
    } catch (e) {
      this.lock = null;
      this.onChange('取得失敗');
    }
  }

  async release() {
    this.wanted = false;
    if (this.lock) {
      try {
        await this.lock.release();
      } catch (_) {}
      this.lock = null;
    }
    this.onChange('解除');
  }
}
