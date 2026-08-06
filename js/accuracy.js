// GNSS 精度の算出：水平精度推定（GST / HDOP×UERE）、
// 静的測位の集計（平均・標準偏差・DRMS・CEP50/CEP95 など）。
// 緯度経度 ↔ メートル換算は局所平面近似（緯度に応じた 1度あたり m）で行う。

// 緯度 lat[deg] における 1度あたりのメートル（局所平面近似で十分）
export function metersPerDegree(lat) {
  const rad = (lat * Math.PI) / 180;
  return {
    latM: 111320, // 南北方向
    lonM: 111320 * Math.cos(rad), // 東西方向
  };
}

// 水平精度の推定（優先順）:
//   1. GST があれば lat/lon 標準偏差から DRMS
//   2. 無ければ HDOP × UERE（UERE は設定値、既定 5 m）で概算
// 戻り値: { value: m, source: 'GST' | 'HDOP×UERE' } または null
export function estimateHorizontalAccuracy(epoch, uere = 5) {
  if (epoch.latStd != null && epoch.lonStd != null) {
    return {
      value: Math.sqrt(epoch.latStd ** 2 + epoch.lonStd ** 2),
      source: 'GST',
    };
  }
  if (epoch.hdop != null) {
    return { value: epoch.hdop * uere, source: 'HDOP×UERE' };
  }
  return null;
}

// 収束用の中心/DRMS 履歴から、直近 holdSec 窓での安定性を評価する純粋関数。
// history: [{ t, lat, lon, drms }]（t=経過秒, 中心lat/lon, その時点のDRMS）を時刻昇順で受ける。
// 累積統計は時間とともに必ず平坦化するため、累積値の単純な差分ではなく
// 「直近 holdSec 秒の窓」での中心移動量と DRMS 変動幅で判定する。
//
// 判定は2フェーズある。記録タブのプログレスバーもこの2段で表示する（仕様 8）:
//   フェーズ1 品質の良いエポックが連続 holdSec 秒たまるまで（stableSec が伸びる。
//             品質不良で履歴がリセットされると 0 に戻る＝バーも戻る）
//   フェーズ2 窓がそろってから、中心移動 ≤ centerTolM かつ DRMS変動幅 ≤ drmsTol を待つ
// バーの達成度を描けるよう、判定値だけでなく許容値も返す。
// 返り値: { stable, stableSec, windowReady, centerMoveM, drmsRangeM, centerTolM, drmsTolM }
export function evaluateConvergence(history, elapsedSec, opts) {
  const { minSec, holdSec, centerTolM, drmsTolAbsM, drmsTolPct } = opts;
  // 連続した良好データの長さ [秒]。呼び出し側で古い履歴を間引くため holdSec+α で頭打ちになる。
  const stableSec = history.length ? Math.max(0, elapsedSec - history[0].t) : 0;
  const cur = history.length ? history[history.length - 1] : null;
  const drmsTolM = Math.max(drmsTolAbsM, drmsTolPct * (cur?.drms || 0));
  const pending = {
    stable: false,
    stableSec,
    windowReady: false,
    centerMoveM: null,
    drmsRangeM: null,
    centerTolM,
    drmsTolM,
  };
  if (elapsedSec < minSec || history.length < 2) return pending;

  const cutoff = elapsedSec - holdSec;
  // holdSec 秒前以前の基準点（連続した良好データが holdSec 以上あるか）
  let ref = null;
  for (const h of history) {
    if (h.t <= cutoff) ref = h;
    else break;
  }
  if (!ref) return pending; // 窓を満たしていない（フェーズ1）

  const { latM, lonM } = metersPerDegree(cur.lat);
  const centerMoveM = Math.hypot((cur.lon - ref.lon) * lonM, (cur.lat - ref.lat) * latM);

  const win = history.filter((h) => h.t >= ref.t);
  const drmsVals = win.map((h) => h.drms).filter((v) => v != null);
  const drmsRangeM = drmsVals.length ? Math.max(...drmsVals) - Math.min(...drmsVals) : 0;

  const stable = centerMoveM <= centerTolM && drmsRangeM <= drmsTolM;
  return { ...pending, stable, windowReady: true, centerMoveM, drmsRangeM };
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

// 中央値（外れ値に引きずられない代表値）。集計の中心値と、
// 2系統の時計オフセット（survey.js）で共用する。
export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stddev(arr, mu) {
  if (arr.length < 2) return 0;
  const m = mu != null ? mu : mean(arr);
  return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / (arr.length - 1));
}

// ソート済み半径誤差列から経験的パーセンタイル（線形補間）
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// 静止点記録の集計。epochs は lat/lon を持つエポック群（fix のあるもの）。
// 戻り値（解析タブの DRMS 表示・散布図が使う集計指標一式）:
//   center {lat, lon}・median {lat, lon}・stdEastM/stdNorthM・drms/drms2・
//   cep50/cep95・altMean/altStd・count・fixCounts・avgDop・avgSats・avgSnrUsed・
//   offsets [{e, n}](散布図用：中心からの東西/南北オフセット m)
export function computeStaticStats(epochs) {
  const pts = epochs.filter((e) => e.lat != null && e.lon != null);
  if (!pts.length) return null;

  const lats = pts.map((e) => e.lat);
  const lons = pts.map((e) => e.lon);
  const latMean = mean(lats);
  const lonMean = mean(lons);
  const { latM, lonM } = metersPerDegree(latMean);

  // 中心からの東西(E)/南北(N)オフセット [m]
  const offsets = pts.map((e) => ({
    e: (e.lon - lonMean) * lonM,
    n: (e.lat - latMean) * latM,
  }));

  const stdNorthM = stddev(offsets.map((o) => o.n), 0);
  const stdEastM = stddev(offsets.map((o) => o.e), 0);
  const drms = Math.sqrt(stdNorthM ** 2 + stdEastM ** 2);

  // CEP50/CEP95 は中心からの半径誤差の経験的パーセンタイル（実測ばらつき）
  const radii = offsets.map((o) => Math.sqrt(o.e ** 2 + o.n ** 2)).sort((a, b) => a - b);

  const alts = pts.map((e) => e.altMSL).filter((v) => v != null);
  const altMean = mean(alts);

  const fixCounts = {};
  for (const e of pts) {
    const q = e.fixQuality != null ? e.fixQuality : '-';
    fixCounts[q] = (fixCounts[q] || 0) + 1;
  }

  const dops = { pdop: [], hdop: [], vdop: [] };
  const sats = [];
  const snrUsed = []; // 使用衛星の C/N0（記録全体の受信強度の目安）
  for (const e of pts) {
    if (e.pdop != null) dops.pdop.push(e.pdop);
    if (e.hdop != null) dops.hdop.push(e.hdop);
    if (e.vdop != null) dops.vdop.push(e.vdop);
    if (e.satsUsed != null) sats.push(e.satsUsed);
    for (const s of e.satellites || []) {
      if (s.used && s.snr != null) snrUsed.push(s.snr);
    }
  }

  return {
    count: pts.length,
    center: { lat: latMean, lon: lonMean },
    median: { lat: median(lats), lon: median(lons) },
    stdEastM,
    stdNorthM,
    drms,
    drms2: drms * 2,
    cep50: percentile(radii, 0.5),
    cep95: percentile(radii, 0.95),
    altMean,
    altStd: alts.length ? stddev(alts, altMean) : null,
    fixCounts,
    avgPdop: mean(dops.pdop),
    avgHdop: mean(dops.hdop),
    avgVdop: mean(dops.vdop),
    avgSats: mean(sats),
    avgSnrUsed: mean(snrUsed),
    offsets,
  };
}

// 基準点 from から to への東西(e)/南北(n)オフセット [m]・距離・方位。
// 2つの記録の「中心がどれだけ離れているか」を出すのに使う。
export function offsetBetween(from, to) {
  if (from?.lat == null || to?.lat == null) return null;
  const { latM, lonM } = metersPerDegree(from.lat);
  const e = (to.lon - from.lon) * lonM;
  const n = (to.lat - from.lat) * latM;
  return {
    e,
    n,
    distM: Math.hypot(e, n),
    bearingDeg: ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360,
  };
}

// Android内蔵GNSS サンプル群の集計（仕様 4-8）。
// ばらつきは GNSS受信機と同じ定義（computeStaticStats）で出し、比較に要る3項目を足す:
//   avgAccuracy   Geolocation の accuracy（68%円半径）の平均。DRMS とは定義が違う参考値
//   dupCount      直前と完全に同じ座標だった点数。OS が静止中の更新を間引くと
//                 ばらつきが過小評価される（＝内蔵の方が優秀に見える）ため必ず示す
//   offsetFromRef 基準（GNSS受信機）の中心から見た中心のズレ。真の誤差ではなく相対値
export function computeDeviceStats(samples, refCenter = null) {
  const st = computeStaticStats(samples || []);
  if (!st) return null;

  const pts = (samples || []).filter((s) => s.lat != null && s.lon != null);
  let dupCount = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].lat === pts[i - 1].lat && pts[i].lon === pts[i - 1].lon) dupCount++;
  }

  st.avgAccuracy = mean(pts.map((s) => s.accuracy).filter((v) => v != null));
  st.dupCount = dupCount;
  st.offsetFromRef = offsetBetween(refCenter, st.center);
  return st;
}
