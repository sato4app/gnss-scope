// 生 NMEA の受信経路。実機（BLE / Nordic UART Service）と開発用モックを同居させ、
// どちらも同じ onFrame(テキスト断片) I/F で差し替えられるようにする。
// 行への再分割は LineBuffer（nmea.js）に任せる。
//
// 注意：Web Bluetooth は Android Chrome/Edge・デスクトップ Chrome/Edge のみ。
// iOS(iPhone/iPad)は全ブラウザで非対応。セキュアコンテキスト(HTTPS / localhost)必須。
import { xorChecksum } from './nmea.js';

// ---- 実機：BLE(NUS) ----

// Nordic UART Service（Pico 側 main.py と一致させること）
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 周辺→中央（notify）
const DEVICE_NAME = 'picow'; // Pico W の広告名
const MAX_BACKOFF_MS = 15000; // 自動再接続の待ち時間上限

export class NmeaBle {
  constructor({ onFrame, onStatus } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});
    this.device = null;
    this.tx = null;
    this.decoder = new TextDecoder();
    this.shouldRun = false; // 手動切断と不意の切断を区別するフラグ
    this.backoff = 500;
    this._onValue = this._onValue.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
  }

  // 非対応環境かどうか
  static isSupported() {
    return !!(typeof navigator !== 'undefined' && navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  // Bluetooth が使えない理由を返す（使える場合は null）
  static unavailableReason() {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return 'BluetoothはHTTPS接続が必要です（http://では使えません）';
    }
    if (!NmeaBle.isSupported()) {
      return 'この端末/ブラウザはWeb Bluetooth非対応です（iPhone/iPadは不可。AndroidはChrome/Edgeを使用）';
    }
    return null;
  }

  // デバイス選択ダイアログを開いて接続する（ユーザー操作内で呼ぶこと）
  async connect() {
    if (!NmeaBle.isSupported()) {
      this.onStatus('unsupported');
      return;
    }
    this.onStatus('connecting');
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ name: DEVICE_NAME }],
        optionalServices: [NUS_SERVICE],
      });
    } catch (e) {
      // 選択キャンセル等。再接続はせず待機状態に戻す。
      this.onStatus('disconnected');
      return;
    }
    this.shouldRun = true;
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    await this._openGatt();
  }

  async _openGatt() {
    if (!this.device) return;
    this.onStatus('connecting');
    try {
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(NUS_SERVICE);
      this.tx = await svc.getCharacteristic(NUS_TX);
      await this.tx.startNotifications();
      this.tx.addEventListener('characteristicvaluechanged', this._onValue);
      this.backoff = 500;
      this.onStatus('connected');
    } catch (e) {
      this._scheduleReconnect();
    }
  }

  _onValue(ev) {
    // ev.target.value は DataView。改行を含む断片をそのまま LineBuffer へ渡す。
    this.onFrame(this.decoder.decode(ev.target.value));
  }

  _onDisconnect() {
    if (this.tx) {
      try {
        this.tx.removeEventListener('characteristicvaluechanged', this._onValue);
      } catch (_) {}
      this.tx = null;
    }
    this.onStatus('disconnected');
    if (this.shouldRun) this._scheduleReconnect();
  }

  // 既知デバイスへの再接続はユーザー操作不要（指数バックオフ）
  _scheduleReconnect() {
    if (!this.shouldRun) return;
    this.onStatus('reconnecting');
    setTimeout(() => {
      if (this.shouldRun && this.device) this._openGatt();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  // 手動切断（自動再接続しない）
  disconnect() {
    this.shouldRun = false;
    if (this.device) {
      try {
        this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
      } catch (_) {}
      try {
        if (this.device.gatt.connected) this.device.gatt.disconnect();
      } catch (_) {}
    }
    this.tx = null;
    this.device = null;
    this.onStatus('disconnected');
  }
}

// ---- 開発用：合成NMEA配信 ----
// Pico がなくても動作確認できるようにする。チェックサムは実機と同じ計算（xorChecksum）で
// 付与するのでパーサの検証が通る。1Hz で GNRMC/GNGGA/GNGSA(×N)/GxGSV/GNVTG/GNGST を流し、
// たまにフレームを途中で割って LineBuffer の断片結合も試せるようにしている。
// UART 38400 化でマルチGNSSのフル GSV が届く想定に合わせ、GPS/GLONASS/Galileo/BeiDou/QZSS の
// 5系統を生成し、スカイプロット・SNRチャートを実機相当のデータ量で検証できる。

const MOCK_INTERVAL_MS = 1000; // GNSS の出力レート（1Hz）に合わせる

const nmeaLine = (body) => `$${body}*${xorChecksum(body)}`;

// 10進度 → ddmm.mmmm
function ddmm(deg) {
  const d = Math.floor(Math.abs(deg));
  const m = (Math.abs(deg) - d) * 60;
  return `${d}${m.toFixed(4).padStart(7, '0')}`;
}

// GSAを12スロット固定で安全に組み立てる
function gsa(usedPrns, pdop, hdop, vdop, sysId) {
  const slots = usedPrns.map(String);
  while (slots.length < 12) slots.push('');
  return nmeaLine(`GNGSA,A,3,${slots.join(',')},${pdop},${hdop},${vdop},${sysId}`);
}

function gsvLines(talker, sats) {
  // sats: [prn, elev, azim]、SNRは仰角からおおまかに生成
  const perMsg = 4;
  const total = Math.ceil(sats.length / perMsg);
  const out = [];
  for (let m = 0; m < total; m++) {
    const chunk = sats.slice(m * perMsg, m * perMsg + perMsg);
    let body = `${talker}GSV,${total},${m + 1},${sats.length}`;
    for (const [prn, el, az] of chunk) {
      const snr = el > 40 ? 38 + Math.floor(Math.random() * 12) : 18 + Math.floor(Math.random() * 16);
      body += `,${prn},${el},${az},${snr}`;
    }
    body += ',1';
    out.push(nmeaLine(body));
  }
  return out;
}

export class MockFeeder {
  // withGst: GST あり/なし両方の精度推定経路（GST / HDOP×UERE）を試せるように残している
  constructor(onFrame, { withGst = true } = {}) {
    this.onFrame = onFrame;
    this.withGst = withGst;
    this.timer = null;
    // 箕面大滝付近の基準座標
    this.lat = 34.853667;
    this.lon = 135.472041;
    // $PPICO 模擬用カウンタ（実機の main.py と同じ意味。欠落ゼロの健全な Pico を演じる）
    this.tickCount = 0;
    this.ppicoSeq = 0;
    this.picoRx = 0; // UART 受信行数相当（= 生成した NMEA 行数）
    this.picoTxok = 0; // BLE 送信行数相当（$PPICO 含む）
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), MOCK_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _tick() {
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const time = `${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}.00`;
    const date = `${p2(now.getUTCDate())}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCFullYear() % 100)}`;

    const jitter = () => (Math.random() - 0.5) * 0.00003;
    const lat = this.lat + jitter();
    const lon = this.lon + jitter();
    const la = ddmm(lat);
    const lo = ddmm(lon);
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';

    const numSV = 18 + Math.floor(Math.random() * 5); // 全GNSS（38400でフル受信）想定の使用衛星数
    const hdop = (0.7 + Math.random() * 0.7).toFixed(1);
    const pdop = (1.0 + Math.random() * 0.9).toFixed(1);
    const vdop = (0.9 + Math.random() * 0.8).toFixed(1);
    const alt = (92 + Math.random() * 3).toFixed(1);

    const lines = [];
    lines.push(nmeaLine(`GNRMC,${time},A,${la},${ns},${lo},${ew},0.05,,${date},,,A`));
    lines.push(nmeaLine(`GNGGA,${time},${la},${ns},${lo},${ew},1,${numSV},${hdop},${alt},M,38.0,M,,`));
    lines.push(nmeaLine(`GNVTG,,T,,M,0.05,N,0.09,K,A`));
    if (this.withGst) {
      const sd = () => (0.8 + Math.random() * 1.5).toFixed(2);
      lines.push(nmeaLine(`GNGST,${time},2.5,,,,${sd()},${sd()},${sd()}`));
    }
    // 系統別 GSA（使用衛星 PRN は系統間で重複しないよう割当）
    lines.push(gsa([1, 8, 11, 17, 19, 22, 28], pdop, hdop, vdop, 1)); // GPS
    lines.push(gsa([65, 72, 81], pdop, hdop, vdop, 2)); // GLONASS
    lines.push(gsa([2, 5, 24, 31], pdop, hdop, vdop, 3)); // Galileo
    lines.push(gsa([14, 27, 33, 44], pdop, hdop, vdop, 4)); // BeiDou
    // 系統別 GSV（[prn, 仰角, 方位]）
    lines.push(...gsvLines('GP', [[1, 55, 120], [8, 40, 200], [11, 30, 75], [17, 65, 310], [19, 22, 45], [22, 48, 160], [28, 15, 280]]));
    lines.push(...gsvLines('GL', [[65, 35, 90], [72, 50, 330], [81, 20, 15]])); // GLONASS
    lines.push(...gsvLines('GA', [[2, 62, 45], [5, 28, 130], [24, 47, 250], [31, 18, 300]])); // Galileo
    lines.push(...gsvLines('GB', [[14, 70, 200], [27, 33, 20], [33, 25, 160], [44, 52, 280]])); // BeiDou
    lines.push(...gsvLines('GQ', [[193, 70, 150], [194, 60, 210]])); // QZSS（みちびき）

    // 5秒ごとに $PPICO（受信品質カウンタ）を模擬配信。実機同様、先行行を
    // カウントしてから snapshot → 送信の順（txok は自身を含まない）。
    // 欠落ゼロなので、アプリ側の「BLE欠落（推定）」は 0 になるはず。
    this.tickCount++;
    this.picoRx += lines.length;
    this.picoTxok += lines.length;
    if (this.tickCount % 5 === 0) {
      this.ppicoSeq++;
      lines.push(nmeaLine(`PPICO,${this.ppicoSeq},${this.picoRx},0,0,${this.picoTxok},0`));
      this.picoTxok++; // $PPICO 自身の送信分
    }

    const text = lines.join('\r\n') + '\r\n';

    // 30%の確率で1フレームを途中で割って送る（行バッファのテスト）
    if (Math.random() < 0.3) {
      const cut = Math.floor(text.length * (0.3 + Math.random() * 0.4));
      this.onFrame(text.slice(0, cut));
      setTimeout(() => this.onFrame(text.slice(cut)), 40);
    } else {
      this.onFrame(text);
    }
  }
}
