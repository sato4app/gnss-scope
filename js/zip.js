// ZIP の読み書き。「一覧」タブの出力（1調査日 = 1ファイル）とその取込で使う。
// 外部ライブラリを入れない方針のため自前で持つ（DOM に触らないので Node からも往復テストできる）。
//
// 実装するのは ZIP の最小構成だけ:
//   - 格納方式は deflate（CompressionStream）と無圧縮 store の2つ。
//     CompressionStream('deflate-raw') が無い環境では自動的に store へ落ちる。
//   - ZIP64 なし（1エントリ・全体とも 4GB 未満。1調査日ぶんは写真込みで 25MB 程度）
//   - 暗号化・分割なし。ディレクトリエントリは書かない（名前の '/' で階層を表す）
//   - ファイル名は UTF-8（汎用フラグ bit 11 を立てる）。日本語の地点名をそのまま入れられる
//
// 出力は「エントリを1つずつ詰めて、詰め終わったら元データを手放す」形にしてある
// （zipEncode は同期・非同期どちらの反復可能オブジェクトも受ける）。
// 20地点ぶんの生NMEA を全部メモリに並べてから圧縮すると端末にはつらいため。

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800; // ファイル名を UTF-8 として読ませる（bit 11）
const VERSION = 20; // 2.0（deflate が使える最低版）
const EOCD_SIZE = 22;

// ---- CRC-32（ZIP のエントリごとのチェック値） ----
let crcTable = null;

function ensureCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

export function crc32(bytes) {
  const table = ensureCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 入力の正規化 ----
// 文字列・Uint8Array・ArrayBuffer・Blob（写真）をまとめて受ける。
async function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  throw new Error('ZIP に入れられない種類のデータです');
}

// ---- 圧縮・展開（どちらもブラウザ／Node の標準 API） ----

async function streamBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 圧縮できなければ null（呼び出し側が store で詰める）
async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    return await streamBytes(bytes, new CompressionStream('deflate-raw'));
  } catch (e) {
    return null; // 'deflate-raw' 非対応の古い実装
  }
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('この環境では圧縮された ZIP を展開できません');
  }
  return streamBytes(bytes, new DecompressionStream('deflate-raw'));
}

// ---- 日時（MS-DOS 形式。秒は2秒刻み） ----
function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// ---- 書き出し ----
// entries: { name, data, modifiedAt? } の（非同期でもよい）反復可能オブジェクト。
// compress=false なら無圧縮で詰める（すでに圧縮済みの写真だけのときなど）。
export async function zipEncode(entries, { compress = true, modifiedAt = Date.now() } = {}) {
  const encoder = new TextEncoder();
  const parts = []; // ローカルヘッダ＋本体（Blob へ渡す順に積む）
  const central = [];
  let offset = 0;
  let count = 0;

  for await (const entry of entries) {
    if (!entry) continue;
    const name = encoder.encode(entry.name);
    const raw = await toBytes(entry.data);
    const crc = crc32(raw);
    // 縮まなかったときは store で詰める（JPEG は deflate で膨らむことがある）
    const packed = compress && raw.length ? await deflateRaw(raw) : null;
    const deflated = packed && packed.length < raw.length;
    const body = deflated ? packed : raw;
    const method = deflated ? METHOD_DEFLATE : METHOD_STORE;
    const { time, date } = dosDateTime(entry.modifiedAt ?? modifiedAt);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_SIG, true);
    local.setUint16(4, VERSION, true);
    local.setUint16(6, FLAG_UTF8, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra なし
    parts.push(new Uint8Array(local.buffer), name, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, CENTRAL_SIG, true);
    dir.setUint16(4, VERSION, true);
    dir.setUint16(6, VERSION, true);
    dir.setUint16(8, FLAG_UTF8, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true); // このエントリのローカルヘッダ位置
    central.push(new Uint8Array(dir.buffer), name);

    offset += 30 + name.length + body.length;
    count++;
  }

  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const eocd = new DataView(new ArrayBuffer(EOCD_SIZE));
  eocd.setUint32(0, EOCD_SIG, true);
  eocd.setUint16(8, count, true);
  eocd.setUint16(10, count, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}

// ---- 読み込み ----
// 戻り値: Map<エントリ名, Uint8Array>（ディレクトリエントリは含めない）。
// セントラルディレクトリを索引として使うので、エントリの並び順には依存しない。
export async function zipDecode(source) {
  const bytes = await toBytes(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // EOCD は末尾にある（コメントが付いていることもあるので後ろから探す）
  let eocd = -1;
  const limit = Math.max(0, bytes.length - EOCD_SIZE - 0xffff);
  for (let i = bytes.length - EOCD_SIZE; i >= limit; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP として読めません（末尾レコードがありません）');

  const total = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const files = new Map();

  for (let i = 0; i < total; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL_SIG) {
      throw new Error('ZIP の索引が壊れています');
    }
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // 本体の位置はローカルヘッダから測る（extra の長さがセントラル側と違うことがある）
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const body = bytes.subarray(start, start + compSize);
    if (!name.endsWith('/')) {
      files.set(name, method === METHOD_DEFLATE ? await inflateRaw(body) : body.slice());
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// エントリをテキストとして取り出す（BOM は落とす）。無ければ null。
export function zipText(files, name) {
  const bytes = files.get(name);
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
