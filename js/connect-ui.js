// 接続タブの配線：connect / disconnect、接続状態の表示、受信品質パネル、モック配信の ON/OFF。
// 受信経路（transport.js）のライフサイクルはこのモジュールが持ち、受け取った生フレームは
// onFrame でアプリのパイプライン（app.js）へ渡すだけにする。
import { $ } from './view-utils.js';
import { NmeaBle, MockFeeder } from './transport.js';

const STATUS_LABELS = {
  disconnected: '未接続',
  connecting: '接続処理中…',
  reconnecting: '再接続中…',
  connected: '接続中',
  receiving: '受信中',
  demo: 'モック配信中',
  unsupported: 'BLE非対応',
};

const RECEIVING_SEC = 3; // 最終受信からこの秒数以内なら「受信中」表示

// onFrame: 受信テキスト断片の受け取り先（LineBuffer へ）
// onFlush: 切断時に呼ぶ（組み立て中のエポックを確定させる）
export function initConnectUI({ streamStats, onFrame, onFlush }) {
  let ble = null;
  let mock = null;
  let connState = 'disconnected';
  let lastRxAt = null;

  function handleFrame(frame) {
    lastRxAt = Date.now();
    onFrame(frame);
  }

  function setConnStatus(state) {
    connState = state;
    const label = STATUS_LABELS[state] || state;
    $('conn-status').dataset.state = state;
    $('conn-status').textContent = label;
    $('conn-dot').dataset.state = state;
    $('cn-state').textContent = label;
    $('cn-device').textContent = ble?.device?.name || (mock ? 'モック配信' : '—');
    // 接続処理中でも「切断」で中断できるよう、インスタンスの有無で判定する
    $('btn-connect').disabled = !!ble;
    $('btn-disconnect').disabled = !ble && !mock;
  }

  // 受信品質パネル（M10S→Pico→BLE→アプリの取りこぼし確認）
  function renderRxStats() {
    const s = streamStats;
    $('rx-lines').textContent = `${s.lines} / ${s.csNg}`;
    $('rx-unknown').textContent = `${s.unknown} / ${s.discardedChars}`;
    $('rx-epochs').textContent = `${s.epochs} / ${s.epochGaps}`;
    $('rx-gsv').textContent = String(s.gsvMissing);
    $('rx-ble').textContent = s.bleLossEst == null ? '—' : `${s.bleLossEst} 行`;
    if (s.pico) {
      $('rx-ppico').textContent = `#${s.pico.seq}（欠落 ${s.picoSeqGaps}）`;
      $('rx-pico-uart').textContent = `${s.pico.rx} / ${s.pico.ng}`;
      $('rx-pico-drop').textContent = `${s.pico.drop} / ${s.pico.txng}`;
    } else {
      $('rx-ppico').textContent = '未受信';
      $('rx-pico-uart').textContent = '—';
      $('rx-pico-drop').textContent = '—';
    }
  }

  // 新しい接続 / モック開始 = 新しい測定区間として統計を取り直す
  function resetStats() {
    streamStats.reset();
    renderRxStats();
  }

  function stopMock() {
    if (!mock) return;
    mock.stop();
    mock = null;
    onFlush();
    $('set-mock').checked = false;
    if (!ble) setConnStatus('disconnected');
  }

  // ---- connect（requestDevice はユーザー操作内で呼ぶ） ----
  $('btn-connect').addEventListener('click', async () => {
    const reason = NmeaBle.unavailableReason();
    if (reason) {
      alert(reason + '\n（実機なしの場合は設定タブの「モックNMEA配信」をご利用ください）');
      return;
    }
    stopMock();
    resetStats();
    ble = new NmeaBle({
      onFrame: handleFrame,
      onStatus: (s) => {
        // 受信中表示はタイマー側で管理するため connected を上書きしない
        if (!(s === 'connected' && connState === 'receiving')) setConnStatus(s);
      },
    });
    await ble.connect();
    if (!ble.shouldRun) {
      ble = null;
      setConnStatus('disconnected');
    }
  });

  // ---- disconnect（手動切断。自動再接続しない） ----
  $('btn-disconnect').addEventListener('click', () => {
    if (ble) {
      ble.disconnect();
      ble = null;
      onFlush();
    }
    stopMock();
    setConnStatus('disconnected');
  });

  // ---- モック配信（開発用。設定タブのチェックボックスから） ----
  $('set-mock').addEventListener('change', (e) => {
    if (!e.target.checked) {
      stopMock();
      return;
    }
    if (mock) return;
    if (ble) {
      ble.disconnect();
      ble = null;
    }
    resetStats();
    mock = new MockFeeder(handleFrame);
    mock.start();
    setConnStatus('demo');
  });

  $('btn-rxstats-reset').addEventListener('click', resetStats);

  // 接続中＋データが流れていれば「受信中」へ昇格、最終受信経過も表示
  setInterval(() => {
    renderRxStats();
    if (lastRxAt == null) {
      $('last-recv').textContent = '—';
      return;
    }
    const sec = Math.floor((Date.now() - lastRxAt) / 1000);
    $('last-recv').textContent = `${sec}s前`;
    if (connState === 'connected' && sec <= RECEIVING_SEC) setConnStatus('receiving');
    else if (connState === 'receiving' && sec > RECEIVING_SEC) setConnStatus('connected');
  }, 1000);

  setConnStatus('disconnected');
}
