// NMEA 0183 パーサ（GGA / RMC / GSA / GSV）＋チェックサム検証
// マルチGNSS（GP/GL/GA/GB/BD/GQ/GN）対応。

export const CONSTELLATIONS = {
  GP: { id: 'gps', label: 'GPS' },
  GL: { id: 'glonass', label: 'GLONASS' },
  GA: { id: 'galileo', label: 'Galileo' },
  GB: { id: 'beidou', label: 'BeiDou' },
  BD: { id: 'beidou', label: 'BeiDou' },
  GQ: { id: 'qzss', label: 'QZSS' },
  GN: { id: 'mixed', label: 'Mixed' },
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

// GSA の systemId（NMEA 4.10+）→ コンステレーション
const SYSTEM_ID = { '1': 'gps', '2': 'glonass', '3': 'galileo', '4': 'beidou', '5': 'qzss' };

export function constellationFromTalker(talker) {
  return (CONSTELLATIONS[talker] || CONSTELLATIONS.GN).id;
}

// チェックサム検証：$ と * の間の全文字を XOR し、* の後ろの16進2桁と比較
export function validateChecksum(sentence) {
  if (!sentence.startsWith('$')) return false;
  const star = sentence.indexOf('*');
  if (star < 0) return false;
  let cs = 0;
  for (let i = 1; i < star; i++) cs ^= sentence.charCodeAt(i);
  const expected = sentence.slice(star + 1, star + 3).toUpperCase();
  return cs.toString(16).toUpperCase().padStart(2, '0') === expected;
}

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
  result.talker = tag.slice(0, 2);
  result.type = tag.slice(2);

  if (!result.valid) return result;

  switch (result.type) {
    case 'GGA': return { ...result, ...parseGGA(fields) };
    case 'RMC': return { ...result, ...parseRMC(fields) };
    case 'GSA': return { ...result, ...parseGSA(fields, result.talker) };
    case 'GSV': return { ...result, ...parseGSV(fields, result.talker) };
    default: return result;
  }
}

function num(v) {
  return v === '' || v == null ? null : +v;
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
    geoidSep: num(f[11]),
  };
}

function parseRMC(f) {
  return {
    time: parseTime(f[1]),
    status: f[2], // A=有効 V=無効
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
  return { totalMsgs: +f[1] || 1, msgNum: +f[2] || 1, inView: num(f[3]), sats };
}
