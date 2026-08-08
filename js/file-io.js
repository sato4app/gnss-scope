// 記録のファイル入出力。ここは「文字列を組み立てる」ところまでを担い、
// どのファイルをどう束ねるかは js/package-io.js（出力ZIP）が決める。
//   epochs.csv     1行1エポック（使用衛星の平均 C/N0 を含む）
//   device.csv     1行1サンプル（Android内蔵。レートが違うのでエポックとは別表にする）
//   track.gpx      記録の中心を wpt、生エポック群を trk
//   raw.nmea       受信した行そのもの（**無加工**。コメント行も入れない）
//   raw_index.csv  エポック ↔ raw.nmea の行番号（生NMEA と測位結果の紐付け）
//   point.json     地点まるごと（format 1。単体でも取込できる）
//   survey.json    調査日のメタ＋全地点の集計値（実データなし）
//   compare.csv    調査日の対応表（1行1地点で2系統を並べた表）
// 入力: 出力した JSON（単体 format 1 / バンドル format 2）を読み戻して IndexedDB へ取り込む。
//       出力ZIP（format 3）の取込は js/package-io.js。
// いずれも外部送信はしない。
import { escapeMarkup, localStamp } from './view-utils.js';
import { computeStaticStats, computeDeviceStats } from './accuracy.js';
import { nextPointNo, surveyIdOf } from './survey.js';
import { SERIES } from './constants.js';

// 地点単体の JSON。バンドル（format 2）は取込でのみ読む（出力は ZIP へ集約した）
const JSON_FORMAT = 1;

// Excel がそのまま開けるように CSV は BOM 付き UTF-8 で出す
const BOM = '﻿';

// text は文字列でも Blob でもよい（ZIP は Blob で来る）
export function download(filename, text, mime) {
  const blob = typeof text === 'string' ? new Blob([text], { type: mime }) : text;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeName(label) {
  return (label || 'gnss').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

function isoOrEmpty(ms) {
  return ms != null ? new Date(ms).toISOString() : '';
}

// CSV の1セル。null/undefined は空、区切り文字や引用符を含む文字列は引用する。
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRow = (values) => values.map(csvCell).join(',');

// CSV 1枚ぶん（行の配列 → CRLF 区切りの BOM 付きテキスト）
const csvText = (lines) => BOM + lines.join('\r\n') + '\r\n';

// 小数の桁を揃える（対応表の見やすさ用。null は空セル）
const round = (v, digits) => (v == null ? null : +v.toFixed(digits));

// エポック内の使用衛星の平均 C/N0（CSV の1列に畳む。衛星ごとの明細は JSON 側で保持）
function avgUsedSnr(s) {
  const vals = (s.satellites || []).filter((x) => x.used && x.snr != null).map((x) => x.snr);
  return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
}

// CSV 末尾に付ける「# キー,値」のコメント塊（地点の識別・集計値・比較値で共用）。
// 空行 ＋ 見出し ＋ 各行の形を1か所に決めておく。
function commentBlock(title, pairs) {
  return ['', `# ${title}`, ...pairs.map(([key, value]) => `# ${key},${csvCell(value ?? '')}`)];
}

// どのファイルにも入れる地点の識別（ファイル単体でも「どの調査日の何番地点か」が分かる）
function pointIdentity(session) {
  return [
    ['survey_id', session.surveyId ?? surveyIdOf(session.createdAt)],
    ['point_no', session.pointNo],
    ['label', session.label],
    ['memo', session.memo],
    ['started_at_local', localStamp(session.createdAt)],
    ['ended_at_local', localStamp(session.endedAt)],
  ];
}

// ---- epochs.csv（1行1エポック） ----
export function buildEpochsCsv(session, point) {
  const header = [
    'time_utc', 'recv_at_local', 'lat', 'lon', 'alt_msl_m', 'fix_quality', 'fix_mode',
    'sats_used', 'sats_in_view', 'pdop', 'hdop', 'vdop', 'lat_std_m', 'lon_std_m',
    'speed_kmh', 'course_deg', 'snr_avg_used_dbhz',
  ];
  const lines = [header.join(',')];
  for (const s of point?.samples || []) {
    lines.push(csvRow([
      isoOrEmpty(s.t), localStamp(s.recvAt), s.lat, s.lon, s.altMSL, s.fixQuality, s.fixMode,
      s.satsUsed, s.satsInView, s.pdop, s.hdop, s.vdop, s.latStd, s.lonStd,
      s.speedKmh, s.course, avgUsedSnr(s),
    ]));
  }

  lines.push(...commentBlock('地点', pointIdentity(session)));

  const st = point?.stats;
  if (st) {
    lines.push(...commentBlock('集計値', [
      ['center_lat', st.center.lat], ['center_lon', st.center.lon],
      ['std_east_m', st.stdEastM], ['std_north_m', st.stdNorthM],
      ['drms_m', st.drms], ['2drms_m', st.drms2],
      ['cep50_m', st.cep50], ['cep95_m', st.cep95],
      ['alt_mean_m', st.altMean], ['alt_std_m', st.altStd],
      ['epochs', st.count],
    ]));
  }

  // Android内蔵GNSS の比較値もコメント行に付ける（レートが違うため行としては混ぜない）
  const dst = point?.deviceStats;
  if (dst) {
    lines.push(...commentBlock(`比較: ${SERIES.device.label}（同時取得）`, [
      ['device_epochs', dst.count],
      ['device_center_lat', dst.center.lat], ['device_center_lon', dst.center.lon],
      ['device_std_east_m', dst.stdEastM], ['device_std_north_m', dst.stdNorthM],
      ['device_drms_m', dst.drms], ['device_2drms_m', dst.drms2],
      ['device_cep50_m', dst.cep50], ['device_cep95_m', dst.cep95],
      ['device_avg_accuracy_m', dst.avgAccuracy],
      ['device_duplicate_points', dst.dupCount],
      ['device_center_offset_m', dst.offsetFromRef?.distM],
      ['device_center_offset_bearing_deg', dst.offsetFromRef?.bearingDeg],
    ]));
  }
  return csvText(lines);
}

// ---- device.csv（1行1サンプル。Android内蔵） ----
// エポックと同じ表に混ぜない（レートも点数も揃わず、列の意味が壊れる）。
// t は「OS が測位を確定した時刻」、recv_at は「アプリが受け取った時刻」で別の時計。
export function buildDeviceCsv(session, point) {
  const samples = point?.deviceSamples || [];
  if (!samples.length) return null;
  const header = [
    'fixed_at_utc', 'fixed_at_local', 'recv_at_local', 'lat', 'lon',
    'accuracy_m', 'altitude_ellipsoid_m', 'altitude_accuracy_m', 'speed_mps', 'heading_deg', 'fix_lag_ms',
  ];
  const lines = [header.join(',')];
  for (const s of samples) {
    lines.push(csvRow([
      isoOrEmpty(s.t), localStamp(s.t), localStamp(s.recvAt), s.lat, s.lon,
      s.accuracy, s.altitude, s.altitudeAccuracy, s.speed, s.heading,
      s.recvAt != null && s.t != null ? s.recvAt - s.t : null,
    ]));
  }
  lines.push(...commentBlock('地点', pointIdentity(session)));
  lines.push(...commentBlock(`系統: ${SERIES.device.label}`, [
    ['samples', samples.length],
    ['note', 'WiFi/基地局を融合した測位（Fused Location）。GNSS 単独の性能ではない'],
  ]));
  return csvText(lines);
}

// ---- track.gpx（記録の中心 = wpt、生エポック群 = trk） ----
export function buildGpx(session, point) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<gpx version="1.1" creator="GNSS Scope" xmlns="http://www.topografix.com/GPX/1/1">');

  const st = point?.stats;
  if (st?.center?.lat != null) {
    parts.push(`  <wpt lat="${st.center.lat}" lon="${st.center.lon}">`);
    if (st.altMean != null) parts.push(`    <ele>${st.altMean}</ele>`);
    parts.push(`    <time>${isoOrEmpty(session.createdAt)}</time>`);
    parts.push(`    <name>${escapeMarkup(session.label)}</name>`);
    if (session.memo) parts.push(`    <desc>${escapeMarkup(session.memo)}</desc>`);
    parts.push('  </wpt>');
  }

  if (point?.samples?.length) {
    parts.push('  <trk>');
    parts.push(`    <name>${escapeMarkup(session.label)}（生エポック）</name>`);
    parts.push('    <trkseg>');
    for (const s of point.samples) {
      if (s.lat == null) continue;
      parts.push(`      <trkpt lat="${s.lat}" lon="${s.lon}">`);
      if (s.altMSL != null) parts.push(`        <ele>${s.altMSL}</ele>`);
      parts.push(`        <time>${isoOrEmpty(s.t)}</time>`);
      parts.push('      </trkpt>');
    }
    parts.push('    </trkseg>');
    parts.push('  </trk>');
  }

  parts.push('</gpx>');
  return parts.join('\n') + '\n';
}

// ---- raw.nmea（受信した生行そのまま） ----
// **無加工**。地点情報のコメント行も入れない（RTKLIB など別ツールへそのまま渡せるように）。
// どの地点のものかは、置かれているディレクトリと manifest.json / raw_index.csv で辿る。
export function buildRawNmea(point) {
  const raw = point?.rawNmea;
  if (!raw?.length) return null;
  return raw.map((r) => r.line).join('\r\n') + '\r\n';
}

// ---- raw_index.csv（エポック ↔ raw.nmea の行番号） ----
// 生NMEA を無加工のまま測位結果と紐付けるための索引。
//
// エポックの recvAt は「そのエポックの最初のセンテンスを受け取った時刻」（js/nmea.js の _open）、
// 生行の t は「その行を受け取った時刻」で、どちらも端末時計。よってエポック k の行は
// [recvAt_k, recvAt_{k+1}) に入る行として区切れる。**保存時にエポック境界そのものは
// 持っていないため、これは受信時刻からの再構成（近似）**である。
//   - 先頭のエポックより前に届いた行（記録開始直後の途中から拾った塊）は epoch_no 0
//   - 最後のエポック以降の行は、最後のエポックに含める（未確定の次エポックと区別できない）
//   - 行が 0 のエポックがあれば、その区間の生行が落ちている（BLE 欠落・上限打ち切り）
// 行番号は raw.nmea の 1 起点。
export function buildRawIndex(samples, rawNmea) {
  const lines = rawNmea || [];
  if (!lines.length) return [];
  const epochs = (samples || []).map((s) => ({ t: s.t, recvAt: s.recvAt ?? s.t }));
  const rows = [];
  // 先頭エポックより前の行（どのエポックにも属さない塊）
  const first = epochs.length ? epochs[0].recvAt : Infinity;
  let cursor = 0;
  while (cursor < lines.length && (lines[cursor].t ?? -Infinity) < first) cursor++;
  if (cursor > 0) rows.push({ epochNo: 0, t: null, recvAt: null, from: 1, to: cursor, lines: cursor });

  for (let k = 0; k < epochs.length; k++) {
    const next = k + 1 < epochs.length ? epochs[k + 1].recvAt : Infinity;
    const from = cursor + 1;
    while (cursor < lines.length && (lines[cursor].t ?? -Infinity) < next) cursor++;
    const count = cursor + 1 - from;
    rows.push({
      epochNo: k + 1,
      t: epochs[k].t ?? null,
      recvAt: epochs[k].recvAt ?? null,
      from: count ? from : null,
      to: count ? cursor : null,
      lines: count,
    });
  }
  return rows;
}

export function buildRawIndexCsv(session, point) {
  const rows = buildRawIndex(point?.samples, point?.rawNmea);
  if (!rows.length) return null;
  const lines = ['epoch_no,utc_time,recv_at_ms,recv_at_local,line_from,line_to,lines'];
  for (const r of rows) {
    lines.push(csvRow([r.epochNo, isoOrEmpty(r.t), r.recvAt, localStamp(r.recvAt), r.from, r.to, r.lines]));
  }
  lines.push(...commentBlock('地点', pointIdentity(session)));
  lines.push(...commentBlock('索引の作り', [
    ['note', 'line_from/line_to は raw.nmea の行番号（1起点）'],
    ['note', 'epoch_no 0 は先頭エポックより前に届いた行'],
    ['note', 'エポック境界は受信時刻からの再構成（近似）'],
    ['raw_truncated', session.summary?.rawTruncated || 0],
  ]));
  return csvText(lines);
}

// ---- point.json（地点まるごと。format 1 として単体でも取込できる） ----
// 生NMEA は raw.nmea として別に出すので含めない（同じデータを二重に持たない）。
// 含めなかったことは rawNmeaFile で示す。
export function buildPointJson(session, point, { rawNmeaFile = null } = {}) {
  const body = { ...point };
  if (rawNmeaFile) delete body.rawNmea;
  const data = { app: 'gnss-scope', format: JSON_FORMAT, exportedAt: new Date().toISOString(), session, point: body };
  if (rawNmeaFile) data.rawNmeaFile = rawNmeaFile;
  return JSON.stringify(data);
}

// ---- survey.json（調査日のメタ＋全地点の集計値。実データなし） ----
// 中身を開かずに「その日に何があるか」を読むためのファイル。
export function buildSurveyJson(survey, entries, { kind = 'survey' } = {}) {
  const points = (entries || []).map(({ session, point }) => ({
    session,
    // samples / rawNmea / deviceSamples は各地点のファイル側にある
    point: point ? stripSamples(point) : null,
  }));
  return JSON.stringify({
    app: 'gnss-scope',
    format: 3,
    kind,
    exportedAt: new Date().toISOString(),
    survey,
    points,
  });
}

function stripSamples(point) {
  const { samples, rawNmea, deviceSamples, ...rest } = point;
  return rest;
}

// ---- compare.csv（調査日の対応表。1行1地点） ----
// 「20地点まわった結果、地点ごとに GNSS受信機と Android内蔵がどう違ったか」を1枚の表にする。
// これが2系統比較の入口で、地点の対応は survey_id + point_no で辿る。
// 列名の接頭辞 gnss_ / dev_ は系統を表す（機種名は入れない）。
export const COMPARE_HEADER = [
  'survey_id', 'point_no', 'label', 'memo',
  'started_at_local', 'ended_at_local', 'duration_s', 'stop_reason',
  'gnss_epochs', 'gnss_lat', 'gnss_lon', 'gnss_alt_msl_m',
  'gnss_drms_m', 'gnss_2drms_m', 'gnss_cep50_m', 'gnss_cep95_m',
  'gnss_std_east_m', 'gnss_std_north_m', 'gnss_avg_hdop', 'gnss_avg_sats', 'gnss_avg_snr_dbhz',
  'gnss_raw_lines',
  'dev_samples', 'dev_lat', 'dev_lon',
  'dev_drms_m', 'dev_cep50_m', 'dev_cep95_m', 'dev_std_east_m', 'dev_std_north_m',
  'dev_avg_accuracy_m', 'dev_dup_points',
  'center_offset_m', 'center_offset_bearing_deg', 'drms_ratio_dev_over_gnss',
  'overlap_s', 'cover_gnss_pct', 'cover_device_pct', 'dev_in_record_window',
  'clock_offset_ms', 'dev_fix_lag_ms',
];

// 1地点 → 対応表の1行（純粋関数。テストから直接呼べるよう export する）
export function compareRow(session, point) {
  const st = point?.stats || null;
  const dst = point?.deviceStats || null;
  const w = session.window || null;
  const ov = w?.overlap || null;
  return [
    session.surveyId ?? surveyIdOf(session.createdAt),
    session.pointNo ?? '',
    session.label,
    session.memo || '',
    localStamp(session.createdAt),
    localStamp(session.endedAt),
    round(w?.durationSec, 1),
    session.summary?.stopReason || '',
    st?.count ?? 0,
    st ? round(st.center.lat, 7) : null,
    st ? round(st.center.lon, 7) : null,
    round(st?.altMean, 1),
    round(st?.drms, 3),
    round(st?.drms2, 3),
    round(st?.cep50, 3),
    round(st?.cep95, 3),
    round(st?.stdEastM, 3),
    round(st?.stdNorthM, 3),
    round(st?.avgHdop, 2),
    round(st?.avgSats, 1),
    round(st?.avgSnrUsed, 1),
    session.summary?.rawLines ?? '',
    dst?.count ?? 0,
    dst ? round(dst.center.lat, 7) : null,
    dst ? round(dst.center.lon, 7) : null,
    round(dst?.drms, 3),
    round(dst?.cep50, 3),
    round(dst?.cep95, 3),
    round(dst?.stdEastM, 3),
    round(dst?.stdNorthM, 3),
    round(dst?.avgAccuracy, 2),
    dst?.dupCount ?? '',
    round(dst?.offsetFromRef?.distM, 3),
    round(dst?.offsetFromRef?.bearingDeg, 1),
    st?.drms > 0 && dst?.drms != null ? round(dst.drms / st.drms, 2) : null,
    round(ov?.overlapSec, 1),
    ov?.coverGnss != null ? round(ov.coverGnss * 100, 1) : null,
    ov?.coverDevice != null ? round(ov.coverDevice * 100, 1) : null,
    ov?.deviceInRecording ?? null,
    w?.clockOffsetMs != null ? Math.round(w.clockOffsetMs) : null,
    w?.deviceLagMs != null ? Math.round(w.deviceLagMs) : null,
  ];
}

export function buildCompareCsv(survey, entries) {
  const rows = (entries || []).map(({ session, point }) => csvRow(compareRow(session, point)));
  const lines = [COMPARE_HEADER.join(','), ...rows];
  const gnss = SERIES.gnss.label;
  const dev = SERIES.device.label;
  lines.push('');
  lines.push(`# survey,${csvCell(survey?.id ?? '')}`);
  lines.push(`# points,${rows.length}`);
  lines.push(`# gnss_*: ${gnss} / dev_*: ${dev}`);
  lines.push(`# cover_gnss_pct: ${gnss}の測定区間のうち ${dev} も取れていた割合`);
  lines.push(`# dev_in_record_window: ${dev}のサンプルのうち record→stop の記録区間内にあった点数`);
  lines.push('# clock_offset_ms: 端末時計 − GPS時刻（2系統を同じ時間軸へ並べ直すときの補正量）');
  lines.push(`# dev_fix_lag_ms: ${dev}の 受信時刻 − 測位確定時刻（大きいほど古い fix を返している）`);
  return csvText(lines);
}

// ---- 取込（JSON） ----
// 端末を移した記録・他端末で測った記録を、この端末の一覧に並べて解析できるようにする。
// 取込時は必ず新しい id を採番する（同じファイルを2回読んでも上書きにならない）。
// 地点番号は取込先の調査日で採り直し、元の番号は sourcePointNo に残す。
export async function importSessionFile(file, storage) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    throw new Error(`JSON を解析できませんでした: ${e.message}`);
  }
  const { survey, items } = validate(data);

  const imported = [];
  for (const src of items) {
    imported.push(await importPointData(src, survey, storage));
  }
  return imported;
}

// 1地点ぶんの取込。調査日（surveyId）は元データの日付をそのまま使い、
// 地点番号だけ取込先で採り直す（同じ日の測定は同じ調査日に集まる方が突き合わせやすいため）。
// 出力ZIP の取込（js/package-io.js）も同じ経路を通る。
export async function importPointData(src, survey, storage) {
  const createdAt = src.session.createdAt || Date.now();
  const surveyId = src.session.surveyId || survey?.id || surveyIdOf(createdAt);
  const pointNo = nextPointNo(await storage.getSessionsBySurvey(surveyId), surveyId);
  await storage.ensureSurvey(surveyId, createdAt);

  // 調査日と地点番号まで含めた id（同じミリ秒に別の調査日の地点を取り込んでも衝突しない）
  const id = `imp_${Date.now()}_${surveyId}_${pointNo}`;
  const stats = src.point.stats || computeStaticStats(src.point.samples); // 集計欠落なら再計算
  // Android内蔵GNSS の比較データ（無い JSON も読めるよう任意扱い）
  const deviceSamples = Array.isArray(src.point.deviceSamples) ? src.point.deviceSamples : null;
  const deviceStats = deviceSamples?.length
    ? src.point.deviceStats || computeDeviceStats(deviceSamples, stats?.center || null)
    : null;
  const rawNmea = Array.isArray(src.point.rawNmea) ? src.point.rawNmea : null;

  const session = {
    ...src.session,
    id,
    type: 'record',
    status: 'confirmed', // 取り込んだ地点は最初から確定済み（下書きにはしない）
    surveyId,
    pointNo,
    label: src.session.label || `取込 ${new Date().toLocaleString('ja-JP')}`,
    createdAt,
    importedAt: Date.now(),
    sourceId: src.session.id || null,
    sourcePointNo: src.session.pointNo ?? null, // 元ファイルでの地点番号（対応を辿るため）
    summary: src.session.summary || {
      lat: stats?.center.lat,
      lon: stats?.center.lon,
      altMSL: stats?.altMean,
      count: stats?.count ?? 0,
      drms: stats?.drms,
      cep50: stats?.cep50,
      cep95: stats?.cep95,
      rawLines: rawNmea ? rawNmea.length : null,
      ...(deviceStats
        ? {
            deviceDrms: deviceStats.drms,
            deviceCount: deviceStats.count,
            deviceOffsetM: deviceStats.offsetFromRef?.distM ?? null,
            deviceOffsetDeg: deviceStats.offsetFromRef?.bearingDeg ?? null,
          }
        : {}),
    },
  };
  // 実データは 1 チャンクとして入れる（読み出し経路を記録と 1 本にするため）。
  // point 側には集計値だけを置く。
  const point = { id: `${id}_p`, sessionId: id, surveyId, pointNo, kind: 'record', stats };
  if (deviceStats) point.deviceStats = deviceStats;
  const data = { samples: src.point.samples };
  if (rawNmea) data.rawNmea = rawNmea;
  if (deviceSamples?.length) data.deviceSamples = deviceSamples;
  // 端末内サイズは記録と同じ数え方（容量警告に取込ぶんも乗るように）。
  // 写真は「この端末で付け直す」ものなので枚数・バイト数は 0 から数える
  // （元データの枚数をそのまま持ち込むと、写真が無いのに📷が付いてしまう）。
  session.summary = { ...session.summary, bytes: JSON.stringify(data).length, photoCount: 0, photoBytes: 0 };

  await storage.putImported(session, point, data);
  return { session, point: { ...point, ...data } };
}

// 取り込んだ JSON の最低限の妥当性チェック。単体（format 1）とバンドル（format 2）の両方を受ける。
// 戻り値: { survey|null, items:[{session, point}] }
function validate(data) {
  if (!data || typeof data !== 'object') throw new Error('JSON の形式が不正です');

  if (Array.isArray(data.points)) {
    const items = data.points.map((e, i) => validateEntry(e, `points[${i}]`));
    if (!items.length) throw new Error('バンドルに地点が含まれていません');
    return { survey: data.survey || null, items };
  }
  return { survey: null, items: [validateEntry(data, '')] };
}

export function validateEntry(entry, where) {
  const at = where ? `${where}: ` : '';
  if (!entry || typeof entry !== 'object') throw new Error(`${at}地点データの形式が不正です`);
  const { session, point } = entry;
  if (!session || typeof session !== 'object') throw new Error(`${at}session がありません`);
  if (!point || typeof point !== 'object') throw new Error(`${at}point がありません`);
  if (!Array.isArray(point.samples)) throw new Error(`${at}生エポック（samples）がありません`);
  if (!point.samples.length) throw new Error(`${at}生エポックが 0 件です`);
  return { session, point };
}
