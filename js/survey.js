// 「調査日 → 地点 → 実データ」のツリーを扱う純粋関数群（DOM にも IndexedDB にも触らない）。
// 1日に何十地点もまわる測定で、どの GNSS受信機の記録とどの Android内蔵の測位が
// 「同じ地点・同じ時間」のものかを後から必ず辿れるようにするための ID 体系と検証を持つ。
//
//   surveys   id = 'yyyy-mm-dd'（ローカル日付。ツリーの根＝1日の調査）
//    └ sessions  id = 'rec_<開始ms>' ＋ surveyId / pointNo（枝＝1地点）
//       └ points   sessionId ＋ surveyId / pointNo（葉＝実データ）
//                    samples[]       GNSS受信機のパース済みエポック
//                    rawNmea[]       GNSS受信機の生NMEA行
//                    deviceSamples[] Android内蔵GNSS の測位
//
// 葉にも surveyId / pointNo を複写するのは、point 単体を取り出しても
// 「どの調査日の何番地点か」が分かるようにするため（エクスポートした JSON も同じ形）。
//
// 時刻軸について：受信機のサンプル t は GPS時刻(UTC)、内蔵のサンプル t は端末時計で、
// 別々の時計である。区間の突き合わせは両者が共通に持つ端末時計（受信機側は recvAt）で行い、
// GPS時刻との差は clockOffsetMs として別に残す（docs/design-202607.md 4.）。
import { SERIES } from './constants.js';

const p2 = (n) => String(n).padStart(2, '0');

// ---- ID 体系 ----

// 時刻[ms] → 調査日ID 'yyyy-mm-dd'（端末のローカル日付。UTC ではない）
export function surveyIdOf(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// 調査日ID ＋ 地点番号 → 既定の地点名 'yyyy-mm-dd-01'
export function pointLabel(surveyId, pointNo) {
  return `${surveyId}-${p2(pointNo)}`;
}

// 同じ調査日の既存セッションから次の地点番号を決める。
// 途中の地点を削除しても番号は再利用しない（最大値＋1）。
// 一度エクスポートした対応表と番号がずれないようにするため。
export function nextPointNo(sessions, surveyId) {
  let max = 0;
  for (const s of sessions || []) {
    if (s.surveyId !== surveyId) continue;
    if (Number.isFinite(s.pointNo)) max = Math.max(max, s.pointNo);
  }
  return max + 1;
}

// ---- 測定区間（時間窓） ----

// サンプル列 → 区間 { startedAt, endedAt, durationSec, count }。0件なら null。
// getT でどの時刻フィールドを見るかを差し替える（受信機は recvAt / GPS時刻の両方を取るため）。
export function timeWindow(samples, getT = (s) => s?.t) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const s of samples || []) {
    const t = getT(s);
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
    count++;
  }
  if (!count) return null;
  return { startedAt: min, endedAt: max, durationSec: (max - min) / 1000, count };
}

// 時刻 t が区間 w の中にあるか
const inWindow = (t, w) => !!w && Number.isFinite(t) && t >= w.startedAt && t <= w.endedAt;

// サンプル列のうち区間 w に入っている件数。
// Android内蔵は OS が静止中の更新を間引くため 1〜数点しか来ないことがあり、
// 割合ベースの重なりだけでは対応を判断できない。件数はその場合でも意味を持つ。
export function countInWindow(samples, w, getT = (s) => s?.t) {
  let n = 0;
  for (const s of samples || []) {
    if (inWindow(getT(s), w)) n++;
  }
  return n;
}

// 2つの区間の重なり。地点の対応（同じ時間に測ったか）を後から検証するための値。
//   overlapSec   重なった秒数
//   coverGnss    GNSS受信機の区間のうち Android内蔵も取れていた割合（0〜1）
//   coverDevice  Android内蔵の区間のうち GNSS受信機も取れていた割合（0〜1）
// 片方が1点だけだと区間の長さが 0 になり割合を計算できない。
// その場合は「相手の区間の中にあれば 100%、外なら 0%」として扱う。
export function windowOverlap(gnss, device) {
  if (!gnss || !device) return null;
  const overlapMs = Math.max(0, Math.min(gnss.endedAt, device.endedAt) - Math.max(gnss.startedAt, device.startedAt));
  const cover = (self, other) => {
    const span = self.endedAt - self.startedAt;
    return span > 0 ? overlapMs / span : inWindow(self.startedAt, other) ? 1 : 0;
  };
  return { overlapSec: overlapMs / 1000, coverGnss: cover(gnss, device), coverDevice: cover(device, gnss) };
}

// 端末時計 − GPS時刻 [ms]（中央値）。Android内蔵側は端末時計しか持たないため、
// この値が分かっていれば後から2系統を GPS時刻の軸へ並べ直せる。
// recvAt / t の両方を持つサンプルが無ければ null。
export function clockOffsetMs(samples) {
  const diffs = [];
  for (const s of samples || []) {
    if (Number.isFinite(s?.recvAt) && Number.isFinite(s?.t)) diffs.push(s.recvAt - s.t);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  const m = diffs.length >> 1;
  return diffs.length % 2 ? diffs[m] : (diffs[m - 1] + diffs[m]) / 2;
}

// 1地点ぶんの時間情報をまとめる（recorder.js が session.window に入れる形）。
// startedAt / endedAt は記録操作そのものの時刻（端末時計）で、
// gnss / device はそれぞれの系統で実際にデータが取れていた範囲。
// 区間の突き合わせに使う時刻。2系統とも「アプリが受け取った端末時計の時刻」に揃える。
// 受信機の t は GPS時刻、内蔵の t は OS が測位を確定した時刻で、どちらも別の時計。
// recvAt を持たない古い記録・取込データでは t にフォールバックする。
const rxTime = (s) => s?.recvAt ?? s?.t;

export function buildWindow({ startedAt, endedAt, samples, deviceSamples }) {
  const gnss = timeWindow(samples, rxTime);
  const device = timeWindow(deviceSamples, rxTime);
  const overlap = windowOverlap(gnss, device);
  if (overlap) {
    // 割合だけでは判断できない少数サンプルのために、実数でも対応を残す。
    // 基準は「エポックの範囲」ではなく record→stop の記録区間にする。
    // 受信機の最初のエポックは複数センテンスが揃うまで確定しない（1秒強かかる）ため、
    // 記録開始直後に届いた内蔵のサンプルがエポック範囲の外に落ちてしまう。
    overlap.deviceInRecording = countInWindow(deviceSamples, { startedAt, endedAt }, rxTime);
    overlap.deviceTotal = device.count;
  }
  return {
    startedAt,
    endedAt,
    durationSec: (endedAt - startedAt) / 1000,
    gnss,
    gnssUtc: timeWindow(samples), // GPS時刻(UTC)での範囲。NMEA 側の絶対時刻の記録
    device,
    overlap,
    clockOffsetMs: clockOffsetMs(samples), // 端末時計 − GPS時刻
    // 受信時刻 − 測位確定時刻。Android が古い fix を返していないかの目安。
    deviceLagMs: clockOffsetMs(deviceSamples),
  };
}

// ---- 地点の対応状況 ----

export const PAIRING_LABELS = {
  both: `${SERIES.gnss.label}＋${SERIES.device.label}`,
  gnssOnly: `${SERIES.gnss.label}のみ`,
  deviceOnly: `${SERIES.device.label}のみ`,
  none: 'データなし',
};

// summary から「2系統が揃っているか」を判定する（一覧表示・保存前の警告に使う）
export function pairingOf(summary) {
  const hasGnss = (summary?.count ?? 0) > 0;
  const hasDevice = (summary?.deviceCount ?? 0) > 0;
  if (hasGnss && hasDevice) return 'both';
  if (hasGnss) return 'gnssOnly';
  if (hasDevice) return 'deviceOnly';
  return 'none';
}

// ---- グループ化 ----

// セッション一覧 → 調査日ごとのグループ。新しい調査日が先、日内は地点番号の昇順。
// surveyId を持たない旧データは createdAt のローカル日付へ寄せる。
export function groupBySurvey(sessions) {
  const map = new Map();
  for (const s of sessions || []) {
    const key = s.surveyId || surveyIdOf(s.createdAt);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return [...map.keys()]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((surveyId) => ({
      surveyId,
      sessions: map
        .get(surveyId)
        .sort((a, b) => (a.pointNo ?? 0) - (b.pointNo ?? 0) || a.createdAt - b.createdAt),
    }));
}

// 調査日グループの集計（一覧のヘッダ表示用）。
// 「20地点まわって2系統とも揃ったのは何地点か」が一目で分かるようにする。
export function surveySummary(sessions) {
  const counts = { both: 0, gnssOnly: 0, deviceOnly: 0, none: 0 };
  let drmsSum = 0;
  let drmsN = 0;
  let deviceDrmsSum = 0;
  let deviceDrmsN = 0;
  for (const s of sessions || []) {
    counts[pairingOf(s.summary)]++;
    if (s.summary?.drms != null) {
      drmsSum += s.summary.drms;
      drmsN++;
    }
    if (s.summary?.deviceDrms != null) {
      deviceDrmsSum += s.summary.deviceDrms;
      deviceDrmsN++;
    }
  }
  return {
    points: (sessions || []).length,
    ...counts,
    avgDrms: drmsN ? drmsSum / drmsN : null,
    avgDeviceDrms: deviceDrmsN ? deviceDrmsSum / deviceDrmsN : null,
  };
}

