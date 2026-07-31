// 記録のファイル入出力。
//   出力: CSV / GPX / JSON（生エポック群＋集計値）を Blob + a[download] でローカル保存
//   入力: 出力した JSON を読み戻して IndexedDB へ取り込む
// いずれも外部送信はしない。JSON は { app:'gnss-scope', format, session, point } 形式。
import { escapeMarkup } from './view-utils.js';
import { computeStaticStats, computeDeviceStats } from './accuracy.js';

const JSON_FORMAT = 1;

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(label) {
  return (label || 'gnss').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

function isoOrEmpty(ms) {
  return ms != null ? new Date(ms).toISOString() : '';
}

// エポック内の使用衛星の平均 C/N0（CSV の1列に畳む。衛星ごとの明細は JSON 側で保持）
function avgUsedSnr(s) {
  const vals = (s.satellites || []).filter((x) => x.used && x.snr != null).map((x) => x.snr);
  return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
}

// ---- CSV（BOM 付き UTF-8。Excel でそのまま開ける） ----
export function exportCSV(session, point) {
  const header = [
    'time_utc', 'lat', 'lon', 'alt_msl_m', 'fix_quality', 'fix_mode',
    'sats_used', 'sats_in_view', 'pdop', 'hdop', 'vdop', 'lat_std_m', 'lon_std_m',
    'speed_kmh', 'course_deg', 'snr_avg_used_dbhz',
  ];
  const rows = (point?.samples || []).map((s) => [
    isoOrEmpty(s.t), s.lat, s.lon, s.altMSL, s.fixQuality, s.fixMode,
    s.satsUsed, s.satsInView, s.pdop, s.hdop, s.vdop, s.latStd, s.lonStd,
    s.speedKmh, s.course, avgUsedSnr(s),
  ].map((v) => (v == null ? '' : v)).join(','));

  const lines = [header.join(','), ...rows];

  // 集計値もコメント行として付ける
  const st = point?.stats;
  if (st) {
    lines.push('');
    lines.push('# 集計値');
    for (const [key, value] of [
      ['center_lat', st.center.lat], ['center_lon', st.center.lon],
      ['std_east_m', st.stdEastM], ['std_north_m', st.stdNorthM],
      ['drms_m', st.drms], ['2drms_m', st.drms2],
      ['cep50_m', st.cep50], ['cep95_m', st.cep95],
      ['alt_mean_m', st.altMean], ['alt_std_m', st.altStd],
      ['epochs', st.count],
    ]) {
      lines.push(`# ${key},${value}`);
    }
  }

  // 端末内蔵GNSS の比較値もコメント行に付ける（レートが違うため行としては混ぜない）
  const dst = point?.deviceStats;
  if (dst) {
    lines.push('');
    lines.push('# 比較: 端末内蔵GNSS（同時取得）');
    for (const [key, value] of [
      ['device_epochs', dst.count],
      ['device_center_lat', dst.center.lat], ['device_center_lon', dst.center.lon],
      ['device_std_east_m', dst.stdEastM], ['device_std_north_m', dst.stdNorthM],
      ['device_drms_m', dst.drms], ['device_2drms_m', dst.drms2],
      ['device_cep50_m', dst.cep50], ['device_cep95_m', dst.cep95],
      ['device_avg_accuracy_m', dst.avgAccuracy],
      ['device_duplicate_points', dst.dupCount],
      ['device_center_offset_m', dst.offsetFromRef?.distM],
      ['device_center_offset_bearing_deg', dst.offsetFromRef?.bearingDeg],
    ]) {
      lines.push(`# ${key},${value ?? ''}`);
    }
  }

  download(`${safeName(session.label)}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

// ---- GPX（記録の中心 = wpt、生エポック群 = trk） ----
export function exportGPX(session, point) {
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
  download(`${safeName(session.label)}.gpx`, parts.join('\n'), 'application/gpx+xml');
}

// ---- JSON（セッション＋地点を丸ごと。importSessionFile で読み戻せる） ----
export function exportJSON(session, point) {
  const data = { app: 'gnss-scope', format: JSON_FORMAT, exportedAt: new Date().toISOString(), session, point };
  download(`${safeName(session.label)}.json`, JSON.stringify(data), 'application/json');
}

// ---- 取込 ----
// 端末を移した記録・他端末で測った記録を、この端末の一覧に並べて解析できるようにする。
// 取込時は必ず新しい id を採番する（同じファイルを2回読んでも上書きにならない）。
export async function importSessionFile(file, storage) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    throw new Error(`JSON を解析できませんでした: ${e.message}`);
  }
  const src = validate(data);

  const id = `imp_${Date.now()}`;
  const stats = src.point.stats || computeStaticStats(src.point.samples); // 集計欠落なら再計算
  // 端末内蔵GNSS の比較データ（無い JSON も読めるよう任意扱い）
  const deviceSamples = Array.isArray(src.point.deviceSamples) ? src.point.deviceSamples : null;
  const deviceStats = deviceSamples?.length
    ? src.point.deviceStats || computeDeviceStats(deviceSamples, stats?.center || null)
    : null;
  const session = {
    ...src.session,
    id,
    type: 'record',
    label: src.session.label || `取込 ${new Date().toLocaleString('ja-JP')}`,
    createdAt: src.session.createdAt || Date.now(),
    importedAt: Date.now(),
    sourceId: src.session.id || null,
    summary: src.session.summary || {
      lat: stats?.center.lat,
      lon: stats?.center.lon,
      altMSL: stats?.altMean,
      count: stats?.count ?? 0,
      drms: stats?.drms,
      cep50: stats?.cep50,
      cep95: stats?.cep95,
      ...(deviceStats ? { deviceDrms: deviceStats.drms, deviceCount: deviceStats.count } : {}),
    },
  };
  const point = { id: `${id}_p`, sessionId: id, kind: 'record', stats, samples: src.point.samples };
  if (deviceStats) {
    point.deviceSamples = deviceSamples;
    point.deviceStats = deviceStats;
  }

  await storage.putSession(session);
  await storage.putPoint(point);
  return { session, point };
}

// 取り込んだ JSON の最低限の妥当性チェック
function validate(data) {
  if (!data || typeof data !== 'object') throw new Error('JSON の形式が不正です');
  const { session, point } = data;
  if (!session || typeof session !== 'object') throw new Error('session がありません');
  if (!point || typeof point !== 'object') throw new Error('point がありません');
  if (!Array.isArray(point.samples)) throw new Error('生エポック（samples）がありません');
  if (!point.samples.length) throw new Error('生エポックが 0 件です');
  return { session, point };
}
