// M10S が流す NMEA を受ける WebSocket 接続。指数バックオフで自動再接続する。
// frame（生の文字列）をそのまま onFrame に渡す。行への分割は LineBuffer 側で行う。
export class NmeaWebSocket {
  constructor(url, { onFrame, onStatus, maxBackoffMs = 15000 } = {}) {
    this.url = url;
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});
    this.maxBackoffMs = maxBackoffMs;
    this.ws = null;
    this.backoff = 500;
    this.shouldRun = false;
    this.lastFrameAt = 0;
    this.status = 'disconnected';
  }

  connect() {
    this.shouldRun = true;
    this._open();
  }

  _open() {
    this._setStatus('connecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.backoff = 500;
      this._setStatus('connected');
    };
    this.ws.onmessage = (ev) => {
      this.lastFrameAt = Date.now();
      const d = ev.data;
      if (typeof d === 'string') this.onFrame(d);
      else if (d instanceof ArrayBuffer) this.onFrame(new TextDecoder().decode(d));
      else if (typeof Blob !== 'undefined' && d instanceof Blob) d.text().then((t) => this.onFrame(t));
    };
    this.ws.onclose = () => {
      this._setStatus('disconnected');
      if (this.shouldRun) this._scheduleReconnect();
    };
    this.ws.onerror = () => {
      try {
        this.ws.close();
      } catch (_) {}
    };
  }

  _scheduleReconnect() {
    this._setStatus('reconnecting');
    setTimeout(() => {
      if (this.shouldRun) this._open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
  }

  _setStatus(s) {
    this.status = s;
    this.onStatus(s);
  }

  disconnect() {
    this.shouldRun = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
    }
  }
}
