// 出力ZIP（format 3）の組み立てと取込。「一覧」タブの「出力」ボタンの中身。
//
// 1調査日（または1地点）を1ファイルで持ち出せるようにする。中身は地点ごとのフォルダで、
// **生NMEA は無加工の raw.nmea として置く**（RTKLIB など別ツールへそのまま渡せるように）。
//
//   gnss-scope_2026-08-08.zip
//   ├ manifest.json                     出力の索引（ファイル名に依存せず全ファイルを辿れる）
//   ├ survey.json                       調査日メタ＋全地点のメタ・集計値（実データなし）
//   ├ compare.csv                       対応表（1行1地点）
//   └ points/p02_2026-08-08-02/
//      ├ point.json / epochs.csv / device.csv / track.gpx
//      ├ raw.nmea                       生NMEA（無加工）
//      ├ raw_index.csv                  エポック ↔ raw.nmea の行番号
//      └ photos/ph1.jpg …
//
// 地点と実データの紐付けは3重にしてある。どれか1つが崩れても対応が辿れる:
//   1. パス      同じ地点のファイルが同じディレクトリに同居する
//   2. 中身      CSV は末尾コメント、JSON はフィールドに survey_id / point_no を持つ
//                （raw.nmea だけは無加工なので持たない）
//   3. manifest  points[] が地点 → ファイル名の対応表を持つ
//
// 実データはチャンクを結合するため、**地点ごとに読んで詰め終わったら手放す**
// （20地点ぶんを一度にメモリへ並べない。zipEncode が非同期反復を受けるのはこのため）。
import { zipEncode, zipDecode, zipText } from './zip.js';
import {
  buildCompareCsv, buildDeviceCsv, buildEpochsCsv, buildGpx, buildPointJson,
  buildRawIndexCsv, buildRawNmea, buildSurveyJson, download, importPointData, safeName, validateEntry,
} from './file-io.js';
import { isConfirmed } from './storage.js';
import { pad2 } from './view-utils.js';
import { SERIES } from './constants.js';

export const PACKAGE_FORMAT = 3;

const RAW_NAME = 'raw.nmea';
const RAW_INDEX_NAME = 'raw_index.csv';
const POINT_NAME = 'point.json';

// 地点ぶんのディレクトリ名。地点番号を先頭に付けるので、地点名が重なっても衝突しない。
const pointDir = (session) => `points/p${pad2(session.pointNo ?? 0)}_${safeName(session.label)}`;

// 出力に「どの版のアプリが書いたか」を残す（sw.js の APP_VERSION を尋ねる）。
// Service Worker が居ない状況（開発サーバー・テスト）では null。
async function appVersion() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 500);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data?.version || null);
    };
    navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
  });
}

// ---- 出力 ----
// sessions は確定済みだけを詰める（下書きは地点になっていないので持ち出さない）。
// DOM に触らないので、テストから往復（出力 → 取込）を確かめられる。
export async function buildPackage({ storage, survey, sessions, kind = 'survey', includePhotos = true, onProgress }) {
  const targets = (sessions || []).filter(isConfirmed).sort((a, b) => (a.pointNo ?? 0) - (b.pointNo ?? 0));
  if (!targets.length) throw new Error('出力できる地点がありません（下書きは対象外です）');

  // 集計値だけの一覧を先に作る（実データを結合しないので軽い）
  const metaEntries = [];
  for (const session of targets) {
    metaEntries.push({ session, point: (await storage.getPointRecords(session.id))[0] || null });
  }

  const exportedAt = Date.now();
  const manifestPoints = [];
  const counts = { points: 0, epochs: 0, rawLines: 0, deviceSamples: 0, photos: 0 };

  async function* entries() {
    yield { name: 'survey.json', data: buildSurveyJson(survey, metaEntries, { kind }) };
    yield { name: 'compare.csv', data: buildCompareCsv(survey, metaEntries) };

    let done = 0;
    for (const session of targets) {
      const point = (await storage.getPointsBySession(session.id))[0] || null;
      const dir = pointDir(session);
      const files = { point: POINT_NAME, epochs: 'epochs.csv', gpx: 'track.gpx' };
      const raw = buildRawNmea(point);

      yield { name: `${dir}/${POINT_NAME}`, data: buildPointJson(session, point, { rawNmeaFile: raw ? RAW_NAME : null }) };
      yield { name: `${dir}/epochs.csv`, data: buildEpochsCsv(session, point) };
      yield { name: `${dir}/track.gpx`, data: buildGpx(session, point) };

      const deviceCsv = buildDeviceCsv(session, point);
      if (deviceCsv) {
        files.device = 'device.csv';
        yield { name: `${dir}/device.csv`, data: deviceCsv };
      }
      if (raw) {
        files.raw = RAW_NAME;
        files.rawIndex = RAW_INDEX_NAME;
        yield { name: `${dir}/${RAW_NAME}`, data: raw };
        yield { name: `${dir}/${RAW_INDEX_NAME}`, data: buildRawIndexCsv(session, point) };
      }

      const photoMeta = [];
      if (includePhotos) {
        for (const photo of await storage.getPhotos(session.id)) {
          const file = `photos/ph${photo.seq}.jpg`;
          photoMeta.push({ file, seq: photo.seq, w: photo.w, h: photo.h, bytes: photo.bytes, addedAt: photo.addedAt });
          yield { name: `${dir}/${file}`, data: photo.blob, modifiedAt: photo.addedAt };
        }
      }

      manifestPoints.push({
        surveyId: session.surveyId,
        pointNo: session.pointNo ?? null,
        label: session.label,
        sessionId: session.id,
        startedAt: session.createdAt,
        endedAt: session.endedAt ?? null,
        epochs: point?.samples?.length ?? 0,
        rawLines: point?.rawNmea?.length ?? null,
        rawTruncated: session.summary?.rawTruncated || 0,
        deviceSamples: point?.deviceSamples?.length ?? 0,
        dir,
        files,
        photos: photoMeta,
      });
      counts.points++;
      counts.epochs += point?.samples?.length || 0;
      counts.rawLines += point?.rawNmea?.length || 0;
      counts.deviceSamples += point?.deviceSamples?.length || 0;
      counts.photos += photoMeta.length;

      onProgress?.(++done, targets.length);
    }

    // 索引は最後に詰める（件数が確定してから書くため。読む側はセントラルディレクトリから引く）
    yield {
      name: 'manifest.json',
      data: JSON.stringify(
        {
          app: 'gnss-scope',
          format: PACKAGE_FORMAT,
          kind,
          exportedAt: new Date(exportedAt).toISOString(),
          appVersion: await appVersion(),
          survey: survey || null,
          series: { gnss: SERIES.gnss.label, device: SERIES.device.label },
          counts,
          files: { survey: 'survey.json', compare: 'compare.csv' },
          points: manifestPoints,
        },
        null,
        2
      ),
    };
  }

  const blob = await zipEncode(entries(), { modifiedAt: exportedAt });
  const base = kind === 'point' ? safeName(targets[0].label) : safeName(survey?.id || targets[0].surveyId);
  return { blob, filename: `gnss-scope_${base}.zip`, counts };
}

// 出力ZIP を書き出す（buildPackage ＋ ダウンロード）
export async function exportPackage(options) {
  const { blob, filename, counts } = await buildPackage(options);
  download(filename, blob, 'application/zip');
  return { filename, counts, bytes: blob.size };
}

// ---- 取込 ----
// 出力した ZIP をこの端末の一覧へ戻す。地点の実データ・写真とも復元する。
// 地点番号の採り直しと**重複地点のスキップ**は JSON 取込と同じ規則
// （js/file-io.js の importPointData）。戻り値も同じ { entries, skipped }。
export async function importPackageFile(file, storage) {
  let files;
  try {
    files = await zipDecode(file);
  } catch (e) {
    throw new Error(`ZIP を読めませんでした: ${e.message}`);
  }
  const manifestText = zipText(files, 'manifest.json');
  if (!manifestText) throw new Error('manifest.json がありません（GNSS Scope が出力した ZIP ではありません）');

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (e) {
    throw new Error(`manifest.json を解析できませんでした: ${e.message}`);
  }
  if (manifest.app !== 'gnss-scope') throw new Error('GNSS Scope が出力した ZIP ではありません');
  const list = Array.isArray(manifest.points) ? manifest.points : [];
  if (!list.length) throw new Error('地点が含まれていません');

  const entries = [];
  let skipped = 0;
  for (const [i, meta] of list.entries()) {
    const dir = meta.dir || `points[${i}]`;
    const pointText = zipText(files, `${dir}/${meta.files?.point || POINT_NAME}`);
    if (!pointText) throw new Error(`${dir}: ${POINT_NAME} がありません`);
    let parsed;
    try {
      parsed = JSON.parse(pointText);
    } catch (e) {
      throw new Error(`${dir}: ${POINT_NAME} を解析できませんでした: ${e.message}`);
    }
    const src = validateEntry({ session: parsed.session, point: parsed.point }, dir);

    // 生NMEA は無加工で入っているので、行ごとの受信時刻を索引から復元する
    const rawName = `${dir}/${meta.files?.raw || RAW_NAME}`;
    if (files.has(rawName)) {
      const rawNmea = parseRawNmea(zipText(files, rawName), zipText(files, `${dir}/${meta.files?.rawIndex || RAW_INDEX_NAME}`));
      if (rawNmea.length) src.point = { ...src.point, rawNmea };
    }

    const entry = await importPointData(src, manifest.survey, storage);
    // 既に持っている地点は書かない。写真も足さない（同じ地点に写真だけ増えるのを防ぐ）
    if (!entry) {
      skipped++;
      continue;
    }

    // 写真（縮小済み JPEG）。取り込み直すので枚数・バイト数は addPhoto 側で数え直される
    for (const photo of meta.photos || []) {
      const bytes = files.get(`${dir}/${photo.file}`);
      if (!bytes) continue;
      await storage.addPhoto(entry.session.id, {
        blob: new Blob([bytes], { type: 'image/jpeg' }),
        w: photo.w ?? null,
        h: photo.h ?? null,
      });
    }
    // 写真の枚数は addPhoto が session 側へ書くので、返す地点は読み直す
    // （取込直後にそのまま読込データとして渡すため、手元の写しを古いままにしない）
    if (meta.photos?.length) entry.session = (await storage.getSession(entry.session.id)) || entry.session;
    entries.push(entry);
  }
  return { entries, skipped };
}

// raw.nmea（無加工）＋ raw_index.csv → [{ t, line }]。
// 索引はエポック単位なので、**行ごとの受信時刻はそのエポックの値**になる（近似）。
// 索引が無い場合は t を持たない行として復元する（行そのものは失われない）。
export function parseRawNmea(text, indexText) {
  const lines = (text || '').split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) return [];
  const times = indexText ? rawLineTimes(indexText, lines.length) : null;
  return lines.map((line, i) => ({ t: times?.[i] ?? null, line }));
}

// raw_index.csv → 行番号（0起点）ごとの受信時刻[ms]
function rawLineTimes(indexText, lineCount) {
  const times = new Array(lineCount).fill(null);
  for (const row of indexText.split(/\r?\n/)) {
    if (!/^\d/.test(row)) continue; // ヘッダ・コメント行・空行
    const cells = row.split(',');
    // epoch_no 0（先頭エポックより前の行）は受信時刻を持たない ＝ 空セル。
    // Number('') は 0 になってしまうので、空かどうかを先に見る。
    if (!cells[2] || !cells[4] || !cells[5]) continue;
    const recvAt = Number(cells[2]);
    const from = Number(cells[4]);
    const to = Number(cells[5]);
    if (!Number.isFinite(recvAt) || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    for (let n = from; n <= to && n <= lineCount; n++) times[n - 1] = recvAt;
  }
  return times;
}
