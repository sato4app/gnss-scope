// 記録タブの配線：record → stop → save → load。
//   record: 静止点で連続エポックの収集を開始（Wake Lock 取得）
//   stop:   収集停止 → 集計を「未保存の記録」として表示（自動停止もここへ入る）
//   save:   地点名・メモを付けて IndexedDB へ保存 → そのまま読込データにする
//   load:   保存済み一覧から選ぶ、または JSON ファイルを取り込む
// 収集中のライブ表示・散布図・記録一覧・エクスポートもこのモジュールが持つ。
// 記録中の画面維持（Wake Lock）は記録の一部なのでここに含める（仕様 3-7）。
import { $, fmt, escapeMarkup, satsText, formatStats, sessionMeta, sessionSubText, nextPointLabel } from './view-utils.js';
import { ScatterPlotView } from './charts.js';
import { exportCSV, exportGPX, exportJSON, importSessionFile } from './file-io.js';

export function initRecordUI({ recorder, storage, settings, onLoad, getLoadedId }) {
  const scatterView = new ScatterPlotView($('rec-scatter'));
  const wakeLock = new WakeLockManager((msg) => {
    $('wakelock-state').textContent = `Wake Lock: ${msg}`;
  });
  let pending = null; // 停止後・未保存の記録

  function setRecordingUi(on) {
    $('btn-record').disabled = on;
    $('btn-stop').disabled = !on;
    $('rec-live').hidden = !on;
    $('rec-dot').hidden = !on;
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
    $('rec-result').textContent = '';
    scatterView.clear();
    recorder.start({
      maxSec: settings.maxSec,
      maxEpochs: settings.maxEpochs,
      autoStop: settings.autoStop,
      minSec: settings.minSec,
    });
    setRecordingUi(true);
    await wakeLock.acquire(); // 記録中は画面を維持
  });

  // ---- stop ----（手動。自動停止は recorder 側から onRecordStop で入る）
  $('btn-stop').addEventListener('click', () => {
    if (recorder.isRecording) recorder.stop('manual');
  });

  // 収集中の1エポックごと（app.js から recorder.onUpdate 経由で配られる）
  function onRecordUpdate({ count, elapsedSec, stats, convergence }) {
    $('rc-count').textContent = String(count);
    $('rc-elapsed').textContent = `${Math.floor(elapsedSec)} s`;
    $('rc-drms').textContent = fmt(stats?.drms, 2, ' m');
    $('rc-cep').textContent = fmt(stats?.cep50, 2, ' m');
    $('rc-conv').textContent = convergenceText(elapsedSec, convergence);
    if (stats) scatterView.update(stats);
  }

  // 収束判定の状況（docs/algospec-202607.md 3.）
  function convergenceText(elapsedSec, convergence) {
    if (!settings.autoStop) return '—（自動停止OFF）';
    if (elapsedSec < settings.minSec) {
      return `最低時間まで残り ${Math.max(0, Math.ceil(settings.minSec - elapsedSec))} 秒`;
    }
    if (!convergence) return '待機中（品質不足）';
    if (convergence.centerMoveM == null) return '判定中（安定10秒待ち）';
    return `安定 ${convergence.centerMoveM.toFixed(1)} m / DRMS±${convergence.drmsRangeM.toFixed(1)} m`;
  }

  // 停止（手動・自動とも）
  async function onRecordStop(result) {
    pending = result;
    setRecordingUi(false);
    await wakeLock.release();

    scatterView.update(pending.stats);
    $('rec-result').textContent = formatStats({ label: '未保存の記録', ...pending }, pending.stats);
    if (!pending.stats) {
      pending = null;
      setPendingUi(false);
      return;
    }
    // 既定の地点名は yyyy-mm-dd-xx（同日連番）
    const sessions = await storage.getSessions();
    $('rec-label').value = nextPointLabel(sessions.map((s) => s.label));
    $('rec-memo').value = '';
    setPendingUi(true);
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
      $('rec-result').textContent = formatStats(sessionMeta(entry.session), entry.point.stats);
      await load(entry); // 保存した記録をそのまま解析・地図の対象にする
    } catch (e) {
      alert(`保存に失敗しました: ${e.message}`);
    }
  });

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
      const entry = await importSessionFile(file, storage);
      await load(entry);
      alert(`取り込みました: ${entry.session.label}（${entry.point.samples.length} エポック）`);
    } catch (err) {
      alert(`取り込みに失敗しました: ${err.message}`);
    }
  });

  // 記録一覧の行アクション（読込 / エクスポート / 削除）
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
    const exporters = { csv: exportCSV, gpx: exportGPX, json: exportJSON };
    exporters[act]?.(session, point);
  }

  async function refreshList() {
    const sessions = await storage.getSessions();
    const ul = $('session-list');
    ul.innerHTML = '';
    if (!sessions.length) {
      ul.innerHTML = '<li class="s-sub">記録はまだありません</li>';
      return;
    }
    const loadedId = getLoadedId();
    for (const session of sessions) {
      const li = document.createElement('li');
      if (session.id === loadedId) li.classList.add('loaded');
      const imported = !!session.importedAt;
      li.innerHTML = `
        <div class="s-head">
          <span class="s-type ${imported ? 'imported' : ''}">${imported ? '取込' : '記録'}</span>
          <span class="s-label">${escapeMarkup(session.label)}</span>
        </div>
        <div class="s-sub">${sessionSubText(session)}</div>
        <div class="s-actions">
          <button class="btn" data-act="load">読込</button>
          <button class="btn" data-act="csv">CSV</button>
          <button class="btn" data-act="gpx">GPX</button>
          <button class="btn" data-act="json">JSON</button>
          <button class="btn danger" data-act="del">削除</button>
        </div>`;
      li.querySelector('.s-actions').addEventListener('click', (ev) => {
        const act = ev.target.dataset?.act;
        if (act) runAction(act, session);
      });
      ul.appendChild(li);
    }
  }

  // ---- 現在の測位値（記録していない間も表示する） ----
  function update(epoch, acc) {
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

  return { update, onRecordUpdate, onRecordStop, onShow: () => scatterView.redraw() };
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
