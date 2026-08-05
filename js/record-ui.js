// 記録タブの配線：record → stop → save → load。
//   record: 静止点で連続エポックの収集を開始（Wake Lock 取得）
//   stop:   収集停止 → 集計を「未保存の記録」として表示（自動停止もここへ入る）
//   save:   地点名・メモを付けて IndexedDB へ保存 → そのまま読込データにする
//   load:   保存済み一覧から選ぶ、または JSON ファイルを取り込む
// 収集中のライブ表示・散布図・記録一覧・エクスポートもこのモジュールが持つ。
// 記録一覧は「調査日 → 地点」のツリーで出し、調査日ごとに
// 対応表CSV（1行1地点で2系統を並べた表）とバンドルJSONを出せる。
// 記録中の画面維持（Wake Lock）は記録の一部なのでここに含める（仕様 3-7）。
//
// 画面に出す情報は重複させない（仕様 7）。同じ値の置き場所は1か所だけ:
//   点数・DRMS      → 散布図の下の凡例（renderLegend）
//   経過・収束の状況 → 進捗バー（renderProgress）
//   停止した理由     → 測位結果の見出し（stopSummaryText）
//   それ以外の明細   → 測位結果を開いた中（formatStats / formatCompare / formatWindow）
import {
  $, fmt, escapeMarkup, satsText, formatStats, formatCompare, formatWindow,
  sessionMeta, sessionSubText, pairingSubText, stopSummaryText,
} from './view-utils.js';
import { groupBySurvey, nextPointNo, pointLabel, surveyIdOf, surveySummary } from './survey.js';
import { ScatterPlotView } from './charts.js';
import { deviceStatusText } from './device-gnss.js';
import { Beeper, beepFor } from './beep.js';
import { SERIES } from './constants.js';
import {
  exportCSV, exportGPX, exportJSON, exportNMEA,
  exportSurveyCompareCSV, exportSurveyJSON, importSessionFile,
} from './file-io.js';

// 収束判定の窓 [秒]（recorder.js の CONVERGENCE.holdSec と揃える。副バーの分母）
const HOLD_SEC = 10;

export function initRecordUI({ recorder, storage, settings, onLoad, getLoadedId }) {
  const scatterView = new ScatterPlotView($('rec-scatter'));
  const beeper = new Beeper(() => settings.beep);
  const wakeLock = new WakeLockManager((msg) => {
    $('wakelock-state').textContent = `Wake Lock: ${msg}`;
  });
  let pending = null; // 停止後・未保存の記録
  let latestEpoch = null; // 進捗バー脇の品質表示（衛星数・HDOP）用
  let prevStableSec = 0; // 安定カウントが 0 に戻ったことを見せるため直前値を持つ

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
  }

  // ---- record ----
  $('btn-record').addEventListener('click', async () => {
    if (recorder.isRecording) return;
    if (pending && !confirm('未保存の記録があります。破棄して新しい記録を開始しますか？')) return;
    const epoch = recorder.latestEpoch;
    if (!epoch || epoch.lat == null) {
      alert('有効な測位データがありません。接続（またはモックNMEA配信）を開始してください。');
      return;
    }
    pending = null;
    setPendingUi(false);
    $('rec-result-box').hidden = true;
    $('rec-scatter-box').hidden = false; // ここから散布図を出す（記録前は出さない。仕様 6）
    prevStableSec = 0;
    scatterView.clear(); // 表示半径のヒステリシスも記録ごとに引き継がない
    // 自動再生ポリシーのため、AudioContext はこのクリックの中で用意する（仕様 2）
    beeper.unlock();
    // start() が同期で onUpdate を呼ぶので、凡例と進捗はそこで初期表示される
    recorder.start({
      maxSec: settings.maxSec,
      maxEpochs: settings.maxEpochs,
      autoStop: settings.autoStop,
      minSec: settings.minSec,
      withDevice: settings.deviceGnss, // Android内蔵GNSS の並行取得（比較用）
      saveRaw: settings.saveRawNmea, // 生NMEA行もそのまま残すか
    });
    setRecordingUi(true);
    await wakeLock.acquire(); // 記録中は画面を維持
  });

  // ---- stop ----（手動。自動停止は recorder 側から onRecordStop で入る）
  $('btn-stop').addEventListener('click', () => {
    if (recorder.isRecording) recorder.stop('manual');
  });

  // 収集中の1エポックごと（app.js から recorder.onUpdate 経由で配られる）
  function onRecordUpdate({ count, elapsedSec, stats, convergence, device }) {
    renderProgress(elapsedSec, convergence);
    const outside = stats ? scatterView.update(stats, device?.stats || null) : null;
    renderLegend(
      { count, spanSec: elapsedSec, stats },
      device && { count: device.count, spanSec: device.spanSec, stats: device.stats, status: device.status },
      outside
    );
  }

  // ---- 散布図の凡例（系統名・実測区間・点数・DRMS。仕様 1） ----
  // 点数だけを並べると「内蔵は点が少ない＝劣る」と読めてしまう。実際は
  // 受信機が 1Hz なのに対し内蔵は OS が更新を間引くだけなので、秒数と併記する。
  // gnss/dev は { count, spanSec, stats, status } 。dev が null なら取得OFF。
  function renderLegend(gnss, dev, outside) {
    const rows = [
      seriesRow(SERIES.gnss, gnss, true),
      seriesRow(SERIES.device, dev, false),
    ];
    $('rec-legend').innerHTML = rows.join('');
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

  // 表示範囲の外に出た点の件数（散布図では縁に▲で描かれている）
  function renderOutside(el, outside) {
    const parts = [];
    if (outside?.gnss) parts.push(`${SERIES.gnss.label} ${outside.gnss}点`);
    if (outside?.device) parts.push(`${SERIES.device.label} ${outside.device}点`);
    el.hidden = !parts.length;
    el.textContent = parts.length ? `表示範囲の外側に ${parts.join(' / ')}（▲は方向）` : '';
  }

  // ---- 収束の進捗バー（仕様 8） ----
  // 主バー: 経過 / 上限時間（あと何秒立っていればよいか）＋ 最低時間のマーカー
  // 副バー: フェーズ1「連続良好データ n/10秒」→ 満タン後はフェーズ2「判定中」に切り替え、
  //         中心移動・DRMS幅の達成度を出す。窓が溜まっても中心が動いていれば止まらないため、
  //         バーが満タンのまま待たされる状態を「判定中」として見せる必要がある。
  function renderProgress(elapsedSec, convergence) {
    const maxSec = settings.maxSec;
    const elapsedBar = $('prog-elapsed');
    elapsedBar.style.width = maxSec > 0 ? `${Math.min(elapsedSec / maxSec, 1) * 100}%` : '0';
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
    return `衛星 ${satsText(latestEpoch)}　HDOP ${fmt(latestEpoch.hdop)}　${fixModeText(latestEpoch)}`;
  }

  const fixModeText = (e) => (e.fixMode === 3 ? '3D' : e.fixMode === 2 ? '2D' : 'No fix');

  // 許可ダイアログの結果などをエポック待ちにせず反映する（app.js の onStatus から）。
  // 記録中は次のエポックで凡例ごと描き直されるため、ここでは何もしない。
  function onDeviceStatus() {}

  // 停止（手動・自動とも）
  async function onRecordStop(result) {
    pending = result;
    setRecordingUi(false);
    await wakeLock.release();

    // 収束＝短く2回 / 上限＝長く1回。手動停止・中断停止は鳴らさない（仕様 2）
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
    showResult(stopSummaryText({
      stopReason: pending.stopReason,
      durationSec: (pending.endedAt - pending.startedAt) / 1000,
      count: pending.stats?.count || 0,
      autoStop: pending.autoStop,
    }), pendingText(pending), pending.stopReason);

    if (!pending.stats) {
      pending = null;
      setPendingUi(false);
      return;
    }
    // 既定の地点名は yyyy-mm-dd-xx（調査日 ＋ 同日連番）。保存時に recorder が採番し直す。
    const surveyId = surveyIdOf(pending.startedAt);
    const siblings = await storage.getSessionsBySurvey(surveyId);
    $('rec-label').value = pointLabel(surveyId, nextPointNo(siblings, surveyId));
    $('rec-memo').value = '';
    setPendingUi(true);
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

  // 未保存の記録の結果テキスト（集計 → 2系統の比較 → 測定区間の対応）
  function pendingText(p) {
    const summary = { rawLines: p.rawNmea ? p.rawNmea.length : null, rawTruncated: p.rawTruncated };
    return [
      formatStats({ label: '未保存の記録', ...p }, p.stats),
      p.stats && p.deviceStats ? formatCompare(p.stats, p.deviceStats) : '',
      formatWindow(p.window, summary),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---- save ----
  $('btn-save').addEventListener('click', async () => {
    if (!pending) return;
    try {
      const entry = await recorder.save(pending, {
        label: $('rec-label').value.trim(),
        memo: $('rec-memo').value.trim(),
      });
      pending = null;
      setPendingUi(false);
      const meta = sessionMeta(entry.session);
      showResult(stopSummaryText(meta), savedText(entry.session, entry.point), meta.stopReason);
      await load(entry); // 保存した記録をそのまま解析・地図の対象にする
    } catch (e) {
      alert(`保存に失敗しました: ${e.message}`);
    }
  });

  // 保存済み・読込済みの記録の結果テキスト（未保存版 pendingText と同じ並び）
  function savedText(session, point) {
    const meta = sessionMeta(session);
    return [
      formatStats(meta, point.stats),
      point.stats && point.deviceStats ? formatCompare(point.stats, point.deviceStats) : '',
      formatWindow(session.window, session.summary),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---- load ----
  // 読込中の記録を一覧で強調するため、onLoad → 一覧再描画の順で行う
  async function load(entry) {
    onLoad(entry);
    await refreshList();
  }

  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルを続けて選べるようにする
    if (!file) return;
    try {
      // 単体・バンドル（調査日まるごと）どちらの JSON も同じ入口で受ける
      const entries = await importSessionFile(file, storage);
      await load(entries[entries.length - 1]);
      const epochs = entries.reduce((n, e) => n + e.point.samples.length, 0);
      alert(`取り込みました: ${entries.length} 地点 / 合計 ${epochs} エポック`);
    } catch (err) {
      alert(`取り込みに失敗しました: ${err.message}`);
    }
  });

  // 地点の行アクション（読込 / エクスポート / 削除）
  async function runAction(act, session) {
    if (act === 'load') {
      const point = (await storage.getPointsBySession(session.id))[0];
      if (!point) {
        alert('記録データが見つかりません');
        return;
      }
      await load({ session, point });
      return;
    }
    if (act === 'del') {
      if (!confirm(`「${session.label}」を削除しますか？`)) return;
      await storage.deleteSession(session.id);
      if (session.id === getLoadedId()) await load(null);
      else await refreshList();
      return;
    }
    const point = (await storage.getPointsBySession(session.id))[0] || null;
    const exporters = { csv: exportCSV, gpx: exportGPX, json: exportJSON, nmea: exportNMEA };
    try {
      exporters[act]?.(session, point);
    } catch (e) {
      alert(e.message);
    }
  }

  // 調査日（1日ぶん）のアクション。20地点を1ファイルにまとめて持ち出すための入口。
  async function runSurveyAction(act, survey) {
    if (act === 'delsurvey') {
      const sessions = await storage.getSessionsBySurvey(survey.id);
      if (!confirm(`「${survey.label || survey.id}」の ${sessions.length} 地点をまとめて削除しますか？`)) return;
      const loadedGone = sessions.some((s) => s.id === getLoadedId());
      await storage.deleteSurvey(survey.id);
      if (loadedGone) await load(null);
      else await refreshList();
      return;
    }
    const entries = await storage.getSurveyEntries(survey.id);
    if (!entries.length) {
      alert('この調査日には地点がありません');
      return;
    }
    if (act === 'compare') exportSurveyCompareCSV(survey, entries);
    else if (act === 'bundle') exportSurveyJSON(survey, entries);
  }

  // 記録一覧：調査日 → 地点 のツリー。地点の対応（NMEA / Android が揃っているか）も各行に出す。
  async function refreshList() {
    const ul = $('session-list');
    ul.innerHTML = '';
    const sessions = await storage.getSessions();
    if (!sessions.length) {
      ul.innerHTML = '<li class="s-sub">記録はまだありません</li>';
      return;
    }
    const surveys = new Map((await storage.getSurveys()).map((s) => [s.id, s]));
    const loadedId = getLoadedId();

    for (const group of groupBySurvey(sessions)) {
      const survey = surveys.get(group.surveyId) || { id: group.surveyId, label: group.surveyId };
      const sum = surveySummary(group.sessions);
      const li = document.createElement('li');
      li.className = 'survey';
      li.innerHTML = `
        <details open>
          <summary>
            <span class="sv-date">${escapeMarkup(survey.label || survey.id)}</span>
            <span class="sv-count">${sum.points} 地点</span>
            <span class="sv-pair">両系統 ${sum.both}${sum.gnssOnly ? ` / ${SERIES.gnss.label}のみ ${sum.gnssOnly}` : ''}${sum.deviceOnly ? ` / ${SERIES.device.label}のみ ${sum.deviceOnly}` : ''}</span>
          </summary>
          <div class="sv-sub">平均DRMS: ${SERIES.gnss.label} ${fmt(sum.avgDrms, 2, ' m')} / ${SERIES.device.label} ${fmt(sum.avgDeviceDrms, 2, ' m')}</div>
          <div class="s-actions sv-actions">
            <button class="btn" data-sact="compare">📊 対応表CSV</button>
            <button class="btn" data-sact="bundle">📦 バンドルJSON</button>
            <button class="btn danger" data-sact="delsurvey">日ごと削除</button>
          </div>
          <ul class="point-list"></ul>
        </details>`;
      li.querySelector('.sv-actions').addEventListener('click', (ev) => {
        const act = ev.target.dataset?.sact;
        if (act) runSurveyAction(act, survey);
      });

      const pointList = li.querySelector('.point-list');
      for (const session of group.sessions) pointList.appendChild(pointRow(session, loadedId));
      ul.appendChild(li);
    }
  }

  // 1地点ぶんの行
  function pointRow(session, loadedId) {
    const li = document.createElement('li');
    if (session.id === loadedId) li.classList.add('loaded');
    const imported = !!session.importedAt;
    const hasRaw = (session.summary?.rawLines ?? 0) > 0;
    li.innerHTML = `
      <div class="s-head">
        <span class="s-no">No.${session.pointNo ?? '—'}</span>
        <span class="s-type ${imported ? 'imported' : ''}">${imported ? '取込' : '記録'}</span>
        <span class="s-label">${escapeMarkup(session.label)}</span>
      </div>
      <div class="s-sub">${sessionSubText(session)}</div>
      <div class="s-sub s-pair">${pairingSubText(session)}</div>
      <div class="s-actions">
        <button class="btn" data-act="load">読込</button>
        <button class="btn" data-act="csv">CSV</button>
        <button class="btn" data-act="gpx">GPX</button>
        <button class="btn" data-act="nmea"${hasRaw ? '' : ' disabled'}>NMEA</button>
        <button class="btn" data-act="json">JSON</button>
        <button class="btn danger" data-act="del">削除</button>
      </div>`;
    li.querySelector('.s-actions').addEventListener('click', (ev) => {
      const act = ev.target.dataset?.act;
      if (act) runAction(act, session);
    });
    return li;
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
  refreshList();

  return { update, onRecordUpdate, onRecordStop, onDeviceStatus, onShow: () => scatterView.redraw() };
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
