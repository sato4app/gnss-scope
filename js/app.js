// 全体の配線：WebSocket → 行バッファ → 収録 → パース → エポック集約 → 3ビュー更新。
import { LineBuffer } from './line-buffer.js';
import { parseSentence } from './nmea.js';
import { EpochAssembler } from './epoch.js';
import { NmeaWebSocket } from './ws-client.js';
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
  url: document.getElementById('ws-url'),
  connect: document.getElementById('btn-connect'),
  status: document.getElementById('conn-status'),
  dot: document.querySelector('.brand .dot'),
  rec: document.getElementById('btn-record'),
  recState: document.getElementById('rec-state'),
  demo: document.getElementById('btn-demo'),
};

let socket = null;
let mock = null;

function setStatus(s) {
  els.status.textContent = s;
  els.status.dataset.state = s;
  const live = s === 'connected' || s === 'demo';
  els.dot.style.background = live ? 'var(--good)' : s === 'reconnecting' || s === 'connecting' ? 'var(--warn)' : 'var(--bad)';
}

els.connect.addEventListener('click', () => {
  if (socket && socket.shouldRun) {
    socket.disconnect();
    socket = null;
    assembler.flush();
    els.connect.textContent = '接続';
    setStatus('disconnected');
    return;
  }
  stopDemo();
  const url = els.url.value.trim();
  socket = new NmeaWebSocket(url, { onFrame: handleFrame, onStatus: setStatus });
  socket.connect();
  els.connect.textContent = '切断';
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
