// 同一時刻のセンテンス群を1エポックにまとめる。
// 新しい時刻の GGA/RMC が来たら直前のエポックを確定し onEpoch に渡す。
// 一定時間（idleMs）次の時刻が来なければタイムアウトでも確定する（最終エポック対策）。
export class EpochAssembler {
  constructor({ onEpoch, idleMs = 1500 } = {}) {
    this.onEpoch = onEpoch || (() => {});
    this.idleMs = idleMs;
    this.current = null;
    this.timer = null;
  }

  add(sentence) {
    if (!sentence.valid) {
      if (this.current) this.current.invalidCount++;
      return;
    }
    const timeKey = sentence.time?.key;

    // 時刻付きの文（GGA/RMC）で区切りを判定
    if (timeKey) {
      if (this.current && this.current.timeKey && this.current.timeKey !== timeKey) {
        this._finalize();
      }
      if (!this.current) this._open(timeKey, sentence.time);
      if (!this.current.timeKey) {
        this.current.timeKey = timeKey;
        this.current.time = sentence.time;
      }
    }
    if (!this.current) this._open(null, null); // GSA/GSV が先行したケース

    this._merge(sentence);
    this._armTimer();
  }

  _open(timeKey, time) {
    this.current = {
      timeKey: timeKey || null,
      time: time || null,
      recvAt: Date.now(),
      quality: null,
      fixMode: null,
      lat: null,
      lon: null,
      alt: null,
      numSV: null,
      hdop: null,
      pdop: null,
      vdop: null,
      status: null,
      usedSVs: [], // {constellation, prn}
      satsInView: [], // {constellation, prn, elev, azim, snr}
      sentenceTypes: {}, // 種別カウント（品質統計用）
      invalidCount: 0,
    };
  }

  _merge(s) {
    const c = this.current;
    c.sentenceTypes[s.type] = (c.sentenceTypes[s.type] || 0) + 1;
    switch (s.type) {
      case 'GGA':
        c.quality = s.quality;
        c.numSV = s.numSV;
        c.hdop = s.hdop;
        c.lat = s.lat;
        c.lon = s.lon;
        c.alt = s.alt;
        break;
      case 'RMC':
        c.status = s.status;
        if (c.lat == null) {
          c.lat = s.lat;
          c.lon = s.lon;
        }
        break;
      case 'GSA':
        if (s.fixMode != null) c.fixMode = Math.max(c.fixMode || 0, s.fixMode);
        if (s.pdop != null) c.pdop = s.pdop;
        if (s.vdop != null) c.vdop = s.vdop;
        for (const prn of s.usedSVs) c.usedSVs.push({ constellation: s.constellation, prn });
        break;
      case 'GSV':
        for (const sat of s.sats) c.satsInView.push(sat);
        break;
    }
  }

  _armTimer() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._finalize(), this.idleMs);
  }

  _finalize() {
    clearTimeout(this.timer);
    if (!this.current) return;
    const epoch = this.current;
    this.current = null;
    this.onEpoch(epoch);
  }

  // 接続終了時に呼ぶ
  flush() {
    this._finalize();
  }
}
