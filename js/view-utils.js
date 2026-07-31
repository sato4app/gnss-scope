// 画面共通ユーティリティ：DOM 取得ショートハンド・タブ切替・値→表示文字列の変換。
// DOM に触るのは $ と initTabUI のみで、他は純粋関数（Node からテストできる）。

export const $ = (id) => document.getElementById(id);

// ---- タブ切替 ----
// 下部タブバー ↔ ページ（.page）の排他表示。非表示中は canvas / 地図のサイズが
// 確定しないため、呼び出し側が onShow で再描画する。
export function initTabUI({ onShow, initial = 'connect' } = {}) {
  const notify = onShow || (() => {});
  const pages = [...document.querySelectorAll('.page')];
  const tabs = [...document.querySelectorAll('#tabbar .tab')];
  let current = null;

  function show(page) {
    if (!pages.some((p) => p.id === `page-${page}`)) return;
    current = page;
    for (const p of pages) p.classList.toggle('active', p.id === `page-${page}`);
    for (const t of tabs) t.classList.toggle('active', t.dataset.page === page);
    notify(page);
  }

  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.page));
  show(initial);

  return {
    show,
    get current() {
      return current;
    },
  };
}

// ---- 数値・文字列の整形 ----

// 数値を「—」フォールバック付きで整形（null/undefined は — に）
export const fmt = (v, digits = 1, unit = '') => (v == null ? '—' : v.toFixed(digits) + unit);

// 記号のエスケープ。innerHTML 埋め込みと GPX(XML) 出力で共用する
// （&#39; / &quot; は XML でも有効な文字参照）。
const ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
export const escapeMarkup = (s) => String(s).replace(/[<>&"']/g, (c) => ESCAPES[c]);

// 方位角[deg] → 16方位の日本語表記（記録の中心どうしのズレの向きに使う）
const COMPASS_16 = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
export function bearingText(deg) {
  if (deg == null) return '—';
  return COMPASS_16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// 「使用衛星 / 視野内衛星」の表示（記録タブ・解析タブで共用）
export function satsText(epoch) {
  if (epoch.satsUsed == null && epoch.satsInView == null) return '—';
  return `${epoch.satsUsed ?? '—'} / ${epoch.satsInView ?? '—'}`;
}

// ---- 測位状態 ----

// GSA fixMode（1=測位なし / 2=2D / 3=3D）→ 表示ラベル
export const FIX_MODE = { 1: 'No fix', 2: '2D', 3: '3D' };

// GGA quality（fixQuality）→ バッジ表示
const FIX_BADGE = {
  0: { t: 'No fix', cls: 'bad' },
  1: { t: 'GPS', cls: 'ok' },
  2: { t: 'DGPS', cls: 'ok' },
  4: { t: 'RTK Fixed', cls: 'good' },
  5: { t: 'RTK Float', cls: 'warn' },
  6: { t: '推測航法', cls: 'warn' },
};

// 測位状態バッジ {t, cls} を決める。GGA quality と GSA fixMode を組み合わせる。
export function fixBadge(epoch) {
  if (epoch.fixQuality == null || epoch.fixQuality === 0) return { t: 'No fix', cls: 'bad' };
  if (epoch.fixQuality === 1 && epoch.fixMode === 2) return { t: '2D', cls: 'warn' };
  if (epoch.fixQuality === 1 && epoch.fixMode === 3) return { t: '3D', cls: 'ok' };
  return FIX_BADGE[epoch.fixQuality] || { t: `fix${epoch.fixQuality}`, cls: 'ok' };
}

// ---- 記録の表示 ----

// 記録の停止理由 → 表示ラベル
const STOP_REASON = {
  converged: '収束（中心・DRMS横ばい）',
  timeout: '上限時間到達（未収束）',
  maxEpochs: '上限エポック到達',
  manual: '手動停止',
};

// 停止理由の表示行（stopReason 無しの旧データは空 = manual 相当にフォールバック）
function stopReasonText(reason) {
  if (!reason) return '';
  if (reason === 'manual') return STOP_REASON.manual;
  return `自動停止: ${STOP_REASON[reason] || reason}`;
}

// 記録の既定地点名 "yyyy-mm-dd-xx"（xx=01からの同日連番）を生成する純粋関数。
// labels: 既存セッションのラベル一覧。同日の "yyyy-mm-dd-数値" 形式のみ連番として数える。
export function nextPointLabel(labels, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const prefix = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-`;
  let max = 0;
  for (const label of labels || []) {
    if (typeof label !== 'string' || !label.startsWith(prefix)) continue;
    const rest = label.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, +rest);
  }
  return `${prefix}${p(max + 1)}`;
}

// 測定区間の受信品質（recorder.js が summary.rxStats に残す差分）→ 表示テキスト。
// 「M10S→Pico / Pico→アプリ で取りこぼしなく処理できたか」を1回の記録単位で示す。
function rxStatsText(rx) {
  if (!rx) return '';
  const picoLine = rx.pico
    ? `Pico: UART受信 ${rx.pico.rx} 行（NG ${rx.pico.ng}）　破棄 バッファ${rx.pico.drop}回/BLE${rx.pico.txng}行`
    : 'Pico統計（$PPICO）なし';
  return [
    `受信品質: ${rx.lines} 行（CS NG ${rx.csNg} / 未対応 ${rx.unknown} / 破棄 ${rx.discardedChars} 字）`,
    `エポック欠落 ${rx.epochGaps} / GSV部分欠落 ${rx.gsvMissing} / BLE欠落(推定) ${rx.bleLossEst != null ? `${rx.bleLossEst} 行` : '—'}`,
    picoLine,
  ].join('\n');
}

// 記録の集計テキスト（記録タブの結果パネル・解析タブの DRMS 表示用）。
// meta: { label, stopReason, rxStats } — 保存済みセッションでも未保存の記録でも渡せる形にする。
export function formatStats(meta, st) {
  if (!st) return '有効なエポックが収集できませんでした';
  const fixLine = Object.entries(st.fixCounts).map(([q, n]) => `fix${q}:${n}`).join(' ');
  const reasonLine = stopReasonText(meta?.stopReason);
  const rxText = rxStatsText(meta?.rxStats);
  return [
    ...(reasonLine ? [reasonLine] : []),
    `【${meta?.label || '未保存の記録'}】 収集 ${st.count} エポック`,
    `中心: ${st.center.lat.toFixed(7)}, ${st.center.lon.toFixed(7)}（中央値: ${st.median.lat.toFixed(7)}, ${st.median.lon.toFixed(7)}）`,
    `標準偏差: 東西 ${st.stdEastM.toFixed(2)} m / 南北 ${st.stdNorthM.toFixed(2)} m`,
    `DRMS ${st.drms.toFixed(2)} m / 2DRMS ${st.drms2.toFixed(2)} m`,
    `CEP50 ${st.cep50?.toFixed(2)} m / CEP95 ${st.cep95?.toFixed(2)} m`,
    `標高: 平均 ${fmt(st.altMean, 1)} m ± ${fmt(st.altStd, 1)} m`,
    `fix内訳: ${fixLine}　平均HDOP ${fmt(st.avgHdop)}　平均衛星数 ${fmt(st.avgSats)}`,
    `平均C/N0（使用衛星）: ${fmt(st.avgSnrUsed, 1, ' dBHz')}`,
    ...(rxText ? [rxText] : []),
  ].join('\n');
}

// 端末内蔵GNSS との比較ブロック（DRMS 表示に formatStats の後ろへ付ける。仕様 5-4）。
// st: M10S の集計 / dst: computeDeviceStats の戻り値。
// accuracy は 68% 円半径で DRMS（1σ相当）とは定義が違うため、同じ行に並べず参考値として置く。
export function formatCompare(st, dst) {
  if (!st || !dst) return '';
  const ratio = st.drms > 0 && dst.drms != null ? `（${(dst.drms / st.drms).toFixed(1)}倍）` : '';
  const off = dst.offsetFromRef;
  const lines = [
    `── 比較: 端末内蔵GNSS（同時取得 ${dst.count} 点 / 座標重複 ${dst.dupCount} 点）──`,
    `DRMS: M10S ${st.drms.toFixed(2)} m / 内蔵 ${fmt(dst.drms, 2)} m${ratio}`,
    `CEP50: M10S ${fmt(st.cep50, 2)} m / 内蔵 ${fmt(dst.cep50, 2)} m`,
    `CEP95: M10S ${fmt(st.cep95, 2)} m / 内蔵 ${fmt(dst.cep95, 2)} m`,
    `標準偏差(東西/南北): M10S ${st.stdEastM.toFixed(2)}/${st.stdNorthM.toFixed(2)} m / ` +
      `内蔵 ${fmt(dst.stdEastM, 2)}/${fmt(dst.stdNorthM, 2)} m`,
    `中心のズレ: ${fmt(off?.distM, 2)} m（${bearingText(off?.bearingDeg)}）※M10S 中心からの相対。真の誤差ではない`,
    `内蔵の平均 accuracy: ${fmt(dst.avgAccuracy, 1)} m（68%円半径。DRMS とは定義が異なる参考値）`,
  ];
  // 静止中は OS が更新を間引くことがあり、重複が多いとばらつきが過小評価される
  if (dst.count > 0 && dst.dupCount / dst.count >= 0.3) {
    lines.push('※同じ座標の繰り返しが多く、内蔵のばらつきを過小評価している可能性があります');
  }
  lines.push('※内蔵は WiFi/基地局を融合した測位（Fused Location）で、GNSS 単独の性能ではありません');
  return lines.join('\n');
}

// 保存済みセッション → formatStats に渡す meta
export function sessionMeta(session) {
  return { label: session.label, stopReason: session.summary?.stopReason, rxStats: session.summary?.rxStats };
}

// 記録一覧の副見出しテキスト
export function sessionSubText(session) {
  const when = new Date(session.createdAt).toLocaleString('ja-JP');
  const s = session.summary;
  return (
    `${when}　${s?.count ?? 0}点` +
    (s?.drms != null ? `　DRMS ${s.drms.toFixed(2)}m` : '') +
    (s?.deviceDrms != null ? `（内蔵 ${s.deviceDrms.toFixed(2)}m）` : '') +
    (s?.lat != null ? `　(${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})` : '')
  );
}
