// 端末内蔵GNSS（OS の測位）の並行取得。M10S を記録している同じ区間・同じ場所で
// もう1系統サンプルを集め、DRMS の比較対象にする（仕様 4-8）。
//
// 注意：ブラウザから取れるのは Geolocation API の測位結果だけで、生 NMEA・衛星情報・
// DOP は取得できない（生 NMEA はネイティブアプリ専用 API）。さらに返る値は GNSS 単独では
// なく WiFi / 基地局を融合した Fused Location である。したがって比較は 1 対 1 の時刻同期
// ではなく「ばらつきの統計」同士に留める（accuracy.js の computeDeviceStats）。
//
// 取得は記録中（record → stop）のみ。常時取得は電池を食うだけで比較には要らない。

const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 };

// 状態 → 記録タブ「端末内蔵GNSS」行の表示ラベル
const STATUS_LABELS = {
  idle: '待機中',
  watching: '取得中',
  denied: '未許可（端末の位置情報を許可してください）',
  unavailable: '測位できません',
  timeout: '応答がありません',
  unsupported: 'この端末/ブラウザは非対応',
};

export const deviceStatusText = (status) => STATUS_LABELS[status] || status;

export class DeviceGnss {
  constructor({ onSample, onStatus } = {}) {
    this.onSample = onSample || (() => {});
    this.onStatus = onStatus || (() => {});
    this.watchId = null;
    this.paused = false;
    this.status = 'idle';
    this._onPosition = this._onPosition.bind(this);
    this._onError = this._onError.bind(this);
  }

  static isSupported() {
    return !!(typeof navigator !== 'undefined' && navigator.geolocation);
  }

  get isRunning() {
    return this.watchId != null;
  }

  // 記録開始時に呼ぶ。許可ダイアログはこの中の watchPosition で出る。
  start() {
    if (this.watchId != null) return;
    if (!DeviceGnss.isSupported()) {
      this._setStatus('unsupported');
      return;
    }
    this.paused = false;
    this._setStatus('idle');
    this.watchId = navigator.geolocation.watchPosition(this._onPosition, this._onError, WATCH_OPTIONS);
  }

  // 記録停止時に呼ぶ
  stop() {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this._setStatus('idle');
  }

  // 画面OFF / バックグラウンド中は捨てる（M10S 側の一時停止と歩調を合わせる）
  setPaused(paused) {
    this.paused = paused;
  }

  _onPosition(pos) {
    this._setStatus('watching');
    if (this.paused) return;
    const c = pos.coords;
    this.onSample({
      // t は「OS が測位を確定した時刻」。maximumAge:0 でも Fused Location は
      // 数秒前に確定した fix を返すことがあり、受け取った時刻とは一致しない。
      // 区間の突き合わせには受信時刻 recvAt を使う（M10S 側の recvAt と同じ役割）。
      t: pos.timestamp,
      recvAt: Date.now(),
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy ?? null, // 68% 円半径 [m]
      altitude: c.altitude ?? null, // WGS84 楕円体高。GGA の MSL とは別物なので altMSL には入れない
      altitudeAccuracy: c.altitudeAccuracy ?? null,
      speed: c.speed ?? null,
      heading: c.heading ?? null,
    });
  }

  _onError(err) {
    const BY_CODE = { 1: 'denied', 2: 'unavailable', 3: 'timeout' };
    this._setStatus(BY_CODE[err.code] || 'unavailable');
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }
}
