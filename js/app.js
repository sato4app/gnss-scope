// 全体の配線：WebSocket → 行バッファ → 収録 → パース → エポック集約 → 3ビュー更新。
import { LineBuffer } from './line-buffer.js';
import { parseSentence } from './nmea.js';
import { EpochAssembler } from './epoch.js';
import { NmeaWebSocket } from './ws-client.js';
import { NmeaBle } from './ble-client.js';
import { Recorder } from './recorder.js';
import { FixStatusView } from './views/fix-status.js';
import { SkyPlotView } from './views/sky-plot.js';
import { SnrChartView } from './views/snr-chart.js';
import { TimeSeriesView } from './views/timeseries.js';
import { DataQualityView } from './views/data-quality.js';
import { MockFeeder } from './dev/mock-feeder.js';

const buffer = new LineBuffer();
const recorder = new Recorder();
const fixView = new FixStatusView(document.getElementById('fix-status'));
const skyView = new SkyPlotView(document.getElementById('sky-plot'));
const snrView = new SnrChartView(document.getElementById('snr-chart'));
const tsView = new TimeSeriesView(document.getElementById('timeseries'));
const dqView = new DataQualityView(document.getElementById('data-quality'));

const assembler = new EpochAssembler({
  onEpoch: (epoch) => {
    fixView.update(epoch);
    skyView.update(epoch);
    snrView.update(epoch);
    tsView.update(epoch);
    dqView.update(epoch);
  },
});

// 受信した1行：収録 → パース → エポック集約
function handleLine(line) {
  recorder.record(line);
  assembler.add(parseSentence(line));
}

// フレーム（複数行・断片混在）を行に割って処理
function handleFrame(frame) {
  for (const line of buffer.push(frame)) handleLine(line);
}

// ---- UI ----
const els = {
  transport: document.getElementById('transport'),
  url: document.getElementById('ws-url'),
  connect: document.getElementById('btn-connect'),
  status: document.getElementById('conn-status'),
  dot: document.querySelector('.brand .dot'),
  rec: document.getElementById('btn-record'),
  recState: document.getElementById('rec-state'),
  demo: document.getElementById('btn-demo'),
  hint: document.getElementById('transport-hint'),
};

let socket = null;
let mock = null;

function setStatus(s) {
  els.status.textContent = s;
  els.status.dataset.state = s;
  const live = s === 'connected' || s === 'demo';
  els.dot.style.background = live ? 'var(--good)' : s === 'reconnecting' || s === 'connecting' ? 'var(--warn)' : 'var(--bad)';
}

// Bluetooth が使えない理由を返す（使える場合は null）。
// Web Bluetooth は「セキュアコンテキスト(HTTPS / localhost)」かつ対応ブラウザが必要。
function bleUnavailableReason() {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'Bluetoothは要HTTPS：このページはhttp接続です。Androidは公開中のHTTPS版を開いてください（http://<IP>では使えません）';
  }
  if (!NmeaBle.isSupported()) {
    return 'この端末/ブラウザはWeb Bluetooth非対応です（iPhone/iPadは全ブラウザ不可。AndroidはChrome/Edgeを使用）';
  }
  return null;
}

// 接続方式に応じて URL 欄の表示と注意書きを切り替える
// （Bluetooth はデバイス選択ダイアログで繋ぐため URL 入力は不要）
function applyTransport() {
  const ble = els.transport.value === 'ble';
  els.url.style.display = ble ? 'none' : '';
  els.hint.textContent = ble ? bleUnavailableReason() || '「接続」で picow を選択' : '';
  els.hint.style.color = ble && bleUnavailableReason() ? 'var(--bad)' : 'var(--muted)';
}
els.transport.addEventListener('change', applyTransport);
// 既定値：Web Bluetooth が使える端末(Android Chrome/HTTPS 等)なら Bluetooth、
// 使えない(iPhone / http 接続 等)なら WebSocket を初期選択。
els.transport.value = bleUnavailableReason() ? 'ws' : 'ble';
applyTransport();

els.connect.addEventListener('click', async () => {
  if (socket && socket.shouldRun) {
    socket.disconnect();
    socket = null;
    assembler.flush();
    els.connect.textContent = '接続';
    setStatus('disconnected');
    return;
  }
  stopDemo();
  els.connect.textContent = '切断';
  if (els.transport.value === 'ble') {
    socket = new NmeaBle({ onFrame: handleFrame, onStatus: setStatus });
    await socket.connect();
    // 選択キャンセル／非対応で接続に至らなかった場合はボタンを戻す
    if (!socket.shouldRun) {
      socket = null;
      els.connect.textContent = '接続';
    }
  } else {
    const url = els.url.value.trim();
    socket = new NmeaWebSocket(url, { onFrame: handleFrame, onStatus: setStatus });
    socket.connect();
  }
});

els.rec.addEventListener('click', async () => {
  if (recorder.sessionId) {
    const n = recorder.count;
    await recorder.stopSession();
    els.rec.textContent = '収録開始';
    els.recState.textContent = `停止（${n} 行）`;
  } else {
    await recorder.startSession({ note: els.url.value.trim() });
    els.rec.textContent = '収録停止';
    els.recState.textContent = '収録中…';
  }
});

// 開発用デモ（Pico なしで動作確認）
els.demo.addEventListener('click', () => {
  if (mock) {
    stopDemo();
    return;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
    els.connect.textContent = '接続';
  }
  mock = new MockFeeder(handleFrame);
  mock.start();
  setStatus('demo');
  els.demo.textContent = 'デモ停止';
});

function stopDemo() {
  if (!mock) return;
  mock.stop();
  mock = null;
  assembler.flush();
  els.demo.textContent = 'デモ再生';
}

recorder.init();
setStatus('disconnected');
