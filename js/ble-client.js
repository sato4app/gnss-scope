// Web Bluetooth で Pico W の BLE(Nordic UART Service) から生 NMEA を受ける。
// WebSocket 版(NmeaWebSocket)と同じ I/F：connect()/disconnect()/onFrame/onStatus/shouldRun。
// onFrame には受信テキスト（断片可・行に揃っていなくてよい）をそのまま渡し、
// 行への再分割は LineBuffer 側に任せる（WS 版と完全に同じ後段に乗る）。
//
// 注意：Web Bluetooth は Android Chrome/Edge・デスクトップ Chrome/Edge のみ。
// iOS(iPhone/iPad)は全ブラウザで非対応のため、iPhone では WebSocket を使う。
// またセキュアコンテキスト(HTTPS / localhost)が必須。

// Nordic UART Service（Pico 側 main.py と一致させること）
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 周辺→中央（notify）

export class NmeaBle {
  constructor({ onFrame, onStatus, namePrefix = 'picow', maxBackoffMs = 15000 } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});
    this.namePrefix = namePrefix;
    this.maxBackoffMs = maxBackoffMs;
    this.device = null;
    this.tx = null;
    this.decoder = new TextDecoder();
    this.shouldRun = false;
    this.backoff = 500;
    this.status = 'disconnected';
    this._onValue = this._onValue.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
  }

  // 非対応環境かどうか（UI 側の判定にも使える）
  static isSupported() {
    return !!(typeof navigator !== 'undefined' && navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  async connect() {
    if (!NmeaBle.isSupported()) {
      this._setStatus('unsupported'); // iOS 等：Web Bluetooth 非対応
      return;
    }
    this._setStatus('connecting');
    try {
      // デバイス選択ダイアログ（ユーザー操作が必要）。NUS か名前前方一致で絞り込む。
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE] }, { namePrefix: this.namePrefix }],
        optionalServices: [NUS_SERVICE],
      });
    } catch (e) {
      // 選択キャンセル等。再接続はせず待機状態に戻す。
      this._setStatus('disconnected');
      return;
    }
    this.shouldRun = true;
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    await this._openGatt();
  }

  async _openGatt() {
    if (!this.device) return;
    this._setStatus('connecting');
    try {
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(NUS_SERVICE);
      this.tx = await svc.getCharacteristic(NUS_TX);
      await this.tx.startNotifications();
      this.tx.addEventListener('characteristicvaluechanged', this._onValue);
      this.backoff = 500;
      this._setStatus('connected');
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
    this._setStatus('disconnected');
    if (this.shouldRun) this._scheduleReconnect();
  }

  // 既知デバイスへの再接続はユーザー操作不要（指数バックオフ）
  _scheduleReconnect() {
    if (!this.shouldRun) return;
    this._setStatus('reconnecting');
    setTimeout(() => {
      if (this.shouldRun && this.device) this._openGatt();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
  }

  _setStatus(s) {
    this.status = s;
    this.onStatus(s);
  }

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
  }
}
