// NMEA 受信の下位層。BLE チャンクから 1 エポックまでを一本の流れとして持つ:
//   LineBuffer      BLE チャンク → 1行復元
//   parseSentence   1行 → 構造化されたセンテンス
//   EpochAssembler  同一時刻のセンテンス群 → 1エポック
// 対象は GGA / RMC / GSA / GSV / VTG / GST と Pico 独自文 $PPICO（docs/algospec-202609.md 5.）。
// マルチGNSS（GP/GL/GA/GB/BD/GQ/GN）対応。チェックサム計算は xorChecksum に集約し、
// 検証（validateChecksum）と開発用モックの文生成（transport.js）で共用する。
// このモジュールは他のモジュールへ依存しない（受信経路の最下層に置くため）。

// 内容まで解釈する標準センテンス種別（これ以外の valid 文は「未対応」として計数のみ）
export const PARSED_TYPES = new Set(['GGA', 'RMC', 'GSA', 'GSV', 'VTG', 'GST']);

// トーカーID → コンステレーション識別子（表示名は CONSTELLATION_LABELS 側に集約）
const TALKER_CONSTELLATION = {
  GP: 'gps',
  GL: 'glonass',
  GA: 'galileo',
  GB: 'beidou',
  BD: 'beidou',
  GQ: 'qzss',
  GN: 'mixed',
};

// スカイプロット・SNR・凡例で共有する色（css/style.css の --c-* と一致させること）
export const CONSTELLATION_COLORS = {
  gps: '#4f9dff',
  glonass: '#ff5d5d',
  galileo: '#36c98d',
  beidou: '#f0a93a',
  qzss: '#b07cff',
  mixed: '#8a93a3',
  unknown: '#8a93a3',
};

export const CONSTELLATION_LABELS = {
  gps: 'GPS',
  glonass: 'GLONASS',
  galileo: 'Galileo',
  beidou: 'BeiDou',
  qzss: 'QZSS',
  mixed: 'Mixed',
  unknown: '不明',
};

// GSA の systemId（NMEA 4.10+）→ コンステレーション
const SYSTEM_ID = { '1': 'gps', '2': 'glonass', '3': 'galileo', '4': 'beidou', '5': 'qzss' };

function constellationFromTalker(talker) {
  return TALKER_CONSTELLATION[talker] || TALKER_CONSTELLATION.GN;
}

// ---- 行復元（BLE notify のチャンク → NMEA 1文） ----
// BLE notify のチャンクと NMEA の1行は一致しない（ATT_MTU−3 ごとに分割されて届く）。
// チャンクを連結し、改行と NMEA のチェックサム(*XX)で行末を判定して1文ずつ取り出す。

const NMEA_END = /\*[0-9A-Fa-f]{2}$/; // 完結した NMEA 文の末尾（チェックサム）
const MAX_BUF = 4096; // 行にならないゴミを捨てるまでの上限

export class LineBuffer {
  constructor({ onDiscard } = {}) {
    this.buf = '';
    this.onDiscard = onDiscard || (() => {}); // 溢れ破棄時に文字数を通知（受信品質統計用）
  }

  // チャンク文字列を投入し、完成した行（空行除く）の配列を返す
  push(chunk) {
    this.buf += chunk;
    const out = [];

    // 改行があれば、その手前までを行として確定。末尾断片は持ち越す。
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop();
    for (const p of parts) {
      const t = p.trim();
      if (t) out.push(t);
    }

    // 改行が無くても、*XX で終わっていれば完結した1文として確定。
    // （途中までの断片は *XX に一致しないので持ち越される）
    const rest = this.buf.trim();
    if (rest && NMEA_END.test(rest)) {
      out.push(rest);
      this.buf = '';
    }

    // 暴走防止：行にならないゴミが溜まり続けたら捨てる（捨てた文字数は通知）
    if (this.buf.length > MAX_BUF) {
      this.onDiscard(this.buf.length);
      this.buf = '';
    }

    return out;
  }
}

// ---- チェックサム ----

// $ と * の間の全文字を XOR し、16進2桁（大文字）で返す
export function xorChecksum(body) {
  let cs = 0;
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
  return cs.toString(16).toUpperCase().padStart(2, '0');
}

// チェックサム検証：本体の XOR と * の後ろの16進2桁を比較
export function validateChecksum(sentence) {
  if (!sentence.startsWith('$')) return false;
  const star = sentence.indexOf('*');
  if (star < 0) return false;
  return xorChecksum(sentence.slice(1, star)) === sentence.slice(star + 1, star + 3).toUpperCase();
}

// ---- センテンス解析 ----

const pad = (n) => String(n).padStart(2, '0');

// ddmm.mmmm + 方位（N/S/E/W）→ 10進度
function parseCoord(value, hemi) {
  if (!value) return null;
  const v = parseFloat(value);
  const deg = Math.floor(v / 100);
  const min = v - deg * 100;
  let dec = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') dec = -dec;
  return dec;
}

// hhmmss.ss → 表示用文字列とキー
function parseTime(t) {
  if (!t || t.length < 6) return null;
  const h = +t.slice(0, 2);
  const m = +t.slice(2, 4);
  const s = parseFloat(t.slice(4));
  return { h, m, s, str: `${pad(h)}:${pad(m)}:${pad(Math.floor(s))}`, key: t };
}

function num(v) {
  return v === '' || v == null ? null : +v;
}

// 1行をパースして構造化する。
// チェックサム不正・未対応の文は valid:false / 既知フィールドのみ で返す。
export function parseSentence(raw) {
  const line = raw.trim();
  const result = { raw: line, valid: false, type: null, talker: null };
  if (!line.startsWith('$')) return result;

  const star = line.indexOf('*');
  result.valid = validateChecksum(line);
  const body = star >= 0 ? line.slice(1, star) : line.slice(1);
  const fields = body.split(',');
  const tag = fields[0] || '';

  // プロプライエタリ文（$P...）はタグ全体を type とする（例: PPICO）
  if (tag[0] === 'P') {
    result.type = tag;
    if (result.valid && tag === 'PPICO') return { ...result, ...parsePPICO(fields) };
    return result;
  }

  result.talker = tag.slice(0, 2);
  result.type = tag.slice(2);

  if (!result.valid) return result;

  switch (result.type) {
    case 'GGA': return { ...result, ...parseGGA(fields) };
    case 'RMC': return { ...result, ...parseRMC(fields) };
    case 'GSA': return { ...result, ...parseGSA(fields, result.talker) };
    case 'GSV': return { ...result, ...parseGSV(fields, result.talker) };
    case 'VTG': return { ...result, ...parseVTG(fields) };
    case 'GST': return { ...result, ...parseGST(fields) };
    default: return result;
  }
}

function parseGGA(f) {
  return {
    time: parseTime(f[1]),
    lat: parseCoord(f[2], f[3]),
    lon: parseCoord(f[4], f[5]),
    quality: num(f[6]), // 0無効 1単独 2DGPS 4RTK固定 5RTK浮動 6推測航法
    numSV: num(f[7]),
    hdop: num(f[8]),
    alt: num(f[9]),
  };
}

function parseRMC(f) {
  return {
    time: parseTime(f[1]),
    lat: parseCoord(f[3], f[4]),
    lon: parseCoord(f[5], f[6]),
    speedKn: num(f[7]),
    course: num(f[8]),
    date: f[9] || null, // ddmmyy
  };
}

function parseGSA(f, talker) {
  // $xxGSA,mode1,mode2,sv1..sv12,PDOP,HDOP,VDOP[,systemId]
  const usedSVs = [];
  for (let i = 3; i <= 14; i++) {
    if (f[i]) usedSVs.push(+f[i]);
  }
  return {
    fixMode: num(f[2]), // 1=測位なし 2=2D 3=3D
    usedSVs,
    pdop: num(f[15]),
    hdop: num(f[16]),
    vdop: num(f[17]),
    constellation: SYSTEM_ID[f[18]] || constellationFromTalker(talker),
  };
}

function parseGSV(f, talker) {
  // $xxGSV,totalMsgs,msgNum,inView,[prn,elev,azim,snr]x1..4[,signalId]
  const sats = [];
  for (let i = 4; i + 3 < f.length; i += 4) {
    if (!f[i]) continue;
    sats.push({
      prn: +f[i],
      elev: num(f[i + 1]),
      azim: num(f[i + 2]),
      snr: num(f[i + 3]), // C/N0 [dBHz]。未追尾は空欄→null
      constellation: constellationFromTalker(talker),
    });
  }
  // NMEA 4.10+ は末尾に signalId が付く（フィールド数 4+4n+1 のとき）。
  // GSV グループの完全性チェック（EpochAssembler）のキーに使う。
  const signalId = (f.length - 4) % 4 === 1 ? f[f.length - 1] || null : null;
  return { totalMsgs: +f[1] || 1, msgNum: +f[2] || 1, inView: num(f[3]), sats, signalId };
}

function parseVTG(f) {
  // $xxVTG,courseT,T,courseM,M,speedKn,N,speedKmh,K[,mode]
  return {
    course: num(f[1]),
    speedKn: num(f[5]),
    speedKmh: num(f[7]),
  };
}

function parseGST(f) {
  // $xxGST,time,rms,stdMajor,stdMinor,orient,latStd,lonStd,altStd
  // latStd / lonStd [m] があれば水平精度（DRMS）を直接推定できる。
  return {
    time: parseTime(f[1]),
    latStd: num(f[6]),
    lonStd: num(f[7]),
  };
}

function parsePPICO(f) {
  // $PPICO,seq,rx,ng,drop,txok,txng（Pico 起動からの累計カウンタ）
  return {
    seq: num(f[1]), // 統計文の通し番号（欠落検出用）
    rx: num(f[2]), // UART 受信行数
    ng: num(f[3]), // うちチェックサム NG
    drop: num(f[4]), // バッファ破棄回数
    txok: num(f[5]), // BLE 送信完了行数（$PPICO 含む）
    txng: num(f[6]), // BLE 送信破棄行数
  };
}

// ---- エポック確定 ----
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
