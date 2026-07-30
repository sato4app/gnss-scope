// 同一時刻のセンテンス群（GGA/RMC/GSA/GSV/VTG/GST）を1エポックにまとめる。
// 新しい時刻の文が来たら直前のエポックを確定し onEpoch に渡す。
// 一定時間（idleMs）次の時刻が来なければタイムアウトでも確定する（最終エポック対策）。
// エポックは「表示・記録で実際に使う値」だけを持つ（未使用の生フィールドは持たない）。
export class EpochAssembler {
  constructor({ onEpoch, idleMs = 1500 } = {}) {
    this.onEpoch = onEpoch || (() => {});
    this.idleMs = idleMs;
    this.current = null;
    this.timer = null;
    this.lastDate = null; // RMC の ddmmyy（エポックをまたいで保持）
  }

  add(sentence) {
    if (!sentence || !sentence.valid) return; // 不正文は捨てる（件数は stream-stats.js が数える）
    const timeKey = sentence.time?.key;

    // 時刻付きの文（GGA/RMC/GST）で区切りを判定
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
      speedKmh: null,
      course: null,
      latStd: null,
      lonStd: null,
      usedSVs: [], // {constellation, prn}
      satsInView: [], // {constellation, prn, elev, azim, snr}
      inViewCount: {}, // constellation -> 衛星数
      gsvGroups: {}, // `talker:signalId` -> { total, seen:Set } GSV 完全性チェック用
    };
  }

  _merge(s) {
    const c = this.current;
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
        if (s.speedKn != null) c.speedKmh = s.speedKn * 1.852;
        if (s.course != null) c.course = s.course;
        if (s.date) this.lastDate = s.date;
        if (c.lat == null) {
          c.lat = s.lat;
          c.lon = s.lon;
        }
        break;
      case 'GSA':
        if (s.fixMode != null) c.fixMode = Math.max(c.fixMode || 0, s.fixMode);
        if (s.pdop != null) c.pdop = s.pdop;
        if (s.hdop != null && c.hdop == null) c.hdop = s.hdop;
        if (s.vdop != null) c.vdop = s.vdop;
        for (const prn of s.usedSVs) c.usedSVs.push({ constellation: s.constellation, prn });
        break;
      case 'GSV': {
        if (s.inView != null) c.inViewCount[s.constellation] = s.inView;
        for (const sat of s.sats) c.satsInView.push(sat);
        // GSV は totalMsgs 分割で届く。msgNum の抜けを検出できるよう記録する。
        const key = `${s.talker || '??'}:${s.signalId || ''}`;
        const g = c.gsvGroups[key] || (c.gsvGroups[key] = { total: 0, seen: new Set() });
        g.total = Math.max(g.total, s.totalMsgs || 1);
        g.seen.add(s.msgNum || 1);
        break;
      }
      case 'VTG':
        if (s.speedKmh != null) c.speedKmh = s.speedKmh;
        else if (s.speedKn != null) c.speedKmh = s.speedKn * 1.852;
        if (s.course != null) c.course = s.course;
        break;
      case 'GST':
        c.latStd = s.latStd;
        c.lonStd = s.lonStd;
        break;
    }
  }

  _armTimer() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._finalize(), this.idleMs);
  }

  // 内部バッファ → エポック構造に変換して通知する
  _finalize() {
    clearTimeout(this.timer);
    if (!this.current) return;
    const c = this.current;
    this.current = null;
    this.onEpoch(this._toEpoch(c));
  }

  _toEpoch(c) {
    // 使用衛星PRN（NMEA拡張番号はコンステ間でほぼ一意なのでPRNで照合）
    const usedPrns = new Set(c.usedSVs.map((u) => u.prn));
    const satellites = c.satsInView.map((s) => ({
      sys: s.constellation,
      prn: s.prn,
      elev: s.elev,
      azim: s.azim,
      snr: s.snr,
      used: usedPrns.has(s.prn),
    }));

    // 系統別の使用/視野内内訳
    const usedBySys = {};
    for (const u of c.usedSVs) usedBySys[u.constellation] = (usedBySys[u.constellation] || 0) + 1;

    // GSV の部分欠落（総メッセージ数に対して届かなかった msgNum の数）
    let gsvMissing = 0;
    for (const g of Object.values(c.gsvGroups)) gsvMissing += Math.max(0, g.total - g.seen.size);

    return {
      t: this._buildDate(c.time),
      time: c.time,
      recvAt: c.recvAt,
      lat: c.lat,
      lon: c.lon,
      altMSL: c.alt,
      fixQuality: c.quality,
      fixMode: c.fixMode,
      satsUsed: c.numSV != null ? c.numSV : c.usedSVs.length || null,
      satsInView: satellites.length || Object.values(c.inViewCount).reduce((a, b) => a + b, 0) || null,
      pdop: c.pdop,
      hdop: c.hdop,
      vdop: c.vdop,
      satellites,
      usedBySys,
      inViewBySys: c.inViewCount,
      speedKmh: c.speedKmh,
      course: c.course,
      latStd: c.latStd,
      lonStd: c.lonStd,
      gsvMissing,
    };
  }

  // RMC の日付(ddmmyy) + UTC時刻 → Date。日付未取得なら受信日時で代用。
  _buildDate(time) {
    if (!time) return null;
    if (this.lastDate && this.lastDate.length === 6) {
      const dd = +this.lastDate.slice(0, 2);
      const mm = +this.lastDate.slice(2, 4);
      const yy = +this.lastDate.slice(4, 6);
      return new Date(Date.UTC(2000 + yy, mm - 1, dd, time.h, time.m, Math.floor(time.s), Math.round((time.s % 1) * 1000)));
    }
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), time.h, time.m, Math.floor(time.s)));
  }

  // 接続終了時に呼ぶ
  flush() {
    this._finalize();
  }
}
