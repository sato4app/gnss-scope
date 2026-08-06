// エントリ：各モジュールの結線のみを担う。
// データフロー: 受信経路(BLE/モック) → LineBuffer → parseSentence → EpochAssembler
//             → (記録 / 解析 / 地図) ※再描画は rAF でスロットリング
// 行・エポックは StreamStats（受信品質統計）にも分岐する。$PPICO は統計のみ。
// 画面は「接続 / 記録 / 解析 / 地図 / 設定」のタブ切替。各タブの DOM 操作は *-ui.js 側。
import { $, initTabUI, fixBadge } from './view-utils.js';
import { LineBuffer, parseSentence } from './nmea.js';
import { EpochAssembler } from './epoch.js';
import { StreamStats } from './stream-stats.js';
import { estimateHorizontalAccuracy } from './accuracy.js';
import { Storage } from './storage.js';
import { Recorder } from './recorder.js';
import { DeviceGnss } from './device-gnss.js';
import { MapView, initMapUI } from './map.js';
import { TileCache, initTileUI } from './tile-cache.js';
import { initConnectUI } from './connect-ui.js';
import { initRecordUI } from './record-ui.js';
import { initAnalysisUI } from './analysis-ui.js';
import { initSettingsUI } from './settings-ui.js';
import { DEFAULT_SETTINGS } from './constants.js';

async function main() {
  const storage = new Storage();
  // 旧版を開いたままのタブがあると DB のアップグレードが進まない。案内するしかない
  storage.onBlocked = () => {
    document.body.innerHTML =
      '<p style="padding:24px;line-height:1.8">他のタブでこのアプリが開いています。' +
      'すべて閉じてから再読込してください。</p>';
  };
  await storage.init();
  // 記録開始で下書きを作る以上、最初の追記より前に落ちれば空の下書きが残る。
  // 復元できるデータが 1 件も無いものだけを片付ける（中身のある下書きは消さない）。
  await storage.cleanupEmptyDrafts().catch(() => {});

  // 設定値は永続化しない。起動のたびに js/constants.js の既定値から始め、
  // 設定タブでの変更はこの起動中だけ有効になる。
  const settings = { ...DEFAULT_SETTINGS };

  const mapView = new MapView($('map'), {
    mapType: settings.mapType,
    trackEnabled: settings.trackEnabled,
    follow: true,
  });
  const streamStats = new StreamStats();

  // ---- 記録（UI モジュールは後で生成するため、コールバックは遅延参照） ----
  let recordUI = null;
  let analysisUI = null;
  let mapUI = null;

  // 記録中だけ動かす Android内蔵GNSS（DRMS の比較対象。仕様 4-8）
  const deviceGnss = new DeviceGnss({
    onSample: (sample) => recorder.addDeviceSample(sample),
    onStatus: (status) => recordUI?.onDeviceStatus(status),
  });

  const recorder = new Recorder(storage, {
    getRxStats: () => streamStats.snapshot(), // 記録1回分の受信品質を summary に残す
    deviceGnss,
    onUpdate: (u) => {
      recordUI.onRecordUpdate(u);
      analysisUI.setLiveStats(u.stats, u.device?.stats || null);
    },
    onStop: (pending) => {
      recordUI.onRecordStop(pending);
      analysisUI.setLiveStats(pending.stats, pending.deviceStats || null);
    },
    onFlushError: (failures) => recordUI.onWriteError(failures),
  });

  // 読込データ（load したセッション）を解析タブ・地図タブへ配る
  let loaded = null;
  function setLoaded(entry) {
    loaded = entry;
    analysisUI.setLoaded(entry);
    mapUI.setLoaded(entry);
  }

  // ---- 受信パイプライン（エポック確定 → 各表示の更新。rAF スロットリング） ----
  let latestEpoch = null;
  let renderQueued = false;

  const assembler = new EpochAssembler({
    onEpoch: (epoch) => {
      streamStats.addEpoch(epoch); // エポック数・時刻ギャップ・GSV欠落を集計
      latestEpoch = epoch;
      recorder.addEpoch(epoch);
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        if (latestEpoch) render(latestEpoch);
      });
    },
  });

  const lineBuffer = new LineBuffer({ onDiscard: (chars) => streamStats.noteDiscard(chars) });

  function render(epoch) {
    // fix バッジ：GGA quality と GSA fixMode を組み合わせる（判定は view-utils.js）
    const badge = fixBadge(epoch);
    $('fix-badge').textContent = badge.t;
    $('fix-badge').className = `fix-badge ${badge.cls}`;

    // 水平精度（GST 優先 / HDOP×UERE フォールバック）
    const acc = estimateHorizontalAccuracy(epoch, settings.uere);

    recordUI.update(epoch, acc);
    analysisUI.renderLive(epoch);

    if (epoch.lat != null && epoch.lon != null && epoch.fixQuality > 0) {
      mapView.updatePosition(epoch.lat, epoch.lon, acc ? acc.value : null);
    }
  }

  // ---- 各タブの配線 ----
  recordUI = initRecordUI({
    recorder,
    storage,
    settings,
    onLoad: setLoaded,
    getLoadedId: () => loaded?.session?.id ?? null,
  });
  analysisUI = initAnalysisUI({ settings, getLatestEpoch: () => latestEpoch });
  mapUI = initMapUI({ mapView });
  const settingsUI = initSettingsUI({ settings, mapView });
  initTileUI({ tileCache: new TileCache(), storage, getMapType: () => settings.mapType });
  initConnectUI({
    streamStats,
    onFrame: (frame) => {
      for (const line of lineBuffer.push(frame)) {
        // 記録中なら受信したそのままの行も残す（パースの前に分岐させる。
        // チェックサムNG行・$PPICO も「生」の一部として保存対象に含める）
        recorder.addRawLine(line);
        const parsed = parseLine(line);
        if (parsed) assembler.add(parsed);
      }
    },
    onFlush: () => assembler.flush(),
  });

  // $PPICO は統計のみ（エポックへ回さない）。チェックサム不正も計数して捨てる。
  function parseLine(line) {
    const parsed = parseSentence(line);
    return streamStats.addLine(parsed) ? null : parsed;
  }

  // 非表示中の canvas / 地図はサイズが確定しないため、表示時に描き直す
  const tabUI = initTabUI({
    initial: 'connect',
    onShow: (page) => {
      if (page === 'map') mapUI.onShow();
      else if (page === 'analysis') analysisUI.refresh();
      else if (page === 'record') recordUI.onShow();
      else if (page === 'settings') settingsUI.refreshVersion(); // 開くたびにバージョンを確認
    },
  });

  // 記録の打ち切りは「画面が隠れたか」ではなく「エポックが来ているか」で判定する
  // （recorder.js の途絶タイマー）。画面 OFF・BLE 切断・受信機の電池切れ・fix 喪失を
  // 一様に拾えるうえ、停止判定が addEpoch の中にしか無いことによる「記録が凍る」も防げる。
  // ここに残るのは、非表示中にサイズが確定しない地図の描き直しだけ。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && tabUI.current === 'map') mapView.invalidateSize();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => {
      console.warn('Service Worker 登録失敗:', e);
    });
  }
}

// 起動できなかったこと自体を隠さない（DB を開けない・アップグレードできない等）。
// onBlocked で案内を出している場合は、そちらの文面を上書きしない。
main().catch((e) => {
  console.error('起動に失敗しました:', e);
  if (typeof document === 'undefined' || document.getElementById('boot-error')) return;
  const p = document.createElement('p');
  p.id = 'boot-error';
  p.style.cssText = 'padding:24px;line-height:1.8;color:#ff5d5d';
  p.textContent = `起動に失敗しました: ${e.message}`;
  document.body.prepend(p);
});
