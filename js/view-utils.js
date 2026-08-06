// 画面共通ユーティリティ：DOM 取得ショートハンド・タブ切替・値→表示文字列の変換。
// DOM に触るのは $ と initTabUI のみで、他は純粋関数（Node からテストできる）。
// 2系統の表示名は js/constants.js の SERIES が唯一の出所（機種名は画面に出さない）。
import { SERIES } from './constants.js';

export const $ = (id) => document.getElementById(id);

const GNSS = SERIES.gnss.label;
const DEVICE = SERIES.device.label;

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
    get current() {
      return current;
    },
  };
}

// ---- 数値・文字列の整形 ----

// 2桁ゼロ詰め（時刻・日付の整形で共用）
export const pad2 = (n) => String(n).padStart(2, '0');

// 数値を「—」フォールバック付きで整形（null/undefined は — に）
export const fmt = (v, digits = 1, unit = '') => (v == null ? '—' : v.toFixed(digits) + unit);

// バイト数 → 表示文字列。自前で数えた概算値なので「約」を付けて使う。
export function formatBytes(bytes) {
  if (!(bytes > 0)) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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
const STOP_LABEL = {
  converged: '収束で自動停止',
  timeout: '上限時間で停止',
  maxEpochs: '上限エポックで停止',
  manual: '手動停止',
  stalled: 'データ途絶で停止', // 最終エポックから 10 秒（画面OFF・BLE切断・fix喪失）
  storageError: '保存失敗で停止', // 記録中の追記が続けて失敗した
  crashed: '記録中に中断', // 停止処理が走らないまま落ちた記録を後から確定した
  interrupted: '中断で停止', // 旧版のデータ用（現在は発生しない）
};

// 停止サマリ（記録タブの1行目。詳細は ▶ の中）。仕様 2・3。
// 例) 収束で自動停止（45秒/45点）
//     上限時間で停止（未収束: 180秒/180点）
//     手動停止（収束判定なし: 20秒/20点）  ※自動停止 OFF のときは「未収束」ではない
//     測位データなしで停止（30秒/0点）
// 秒数と点数を併記するのは、1Hz なら本来一致するはずの2つがずれていれば
// 取りこぼし（BLE 欠落・中断）があったと分かるため。
export function stopSummaryText({ stopReason, durationSec, count, autoStop }) {
  const span = `${Math.round(durationSec || 0)}秒/${count || 0}点`;
  if (!count) return `測位データなしで停止（${span}）`;
  const head = STOP_LABEL[stopReason] || STOP_LABEL.manual;
  // 収束停止以外は収束していない。自動停止 OFF なら「判定していない」と書き分ける
  // （autoStop を持たない旧データは、判定していた前提で「未収束」に寄せる）。
  const note = stopReason === 'converged' ? '' : autoStop === false ? '収束判定なし: ' : '未収束: ';
  return `${head}（${note}${span}）`;
}

// 時刻[ms] → ローカルの 'HH:MM:SS'（測定区間の表示用）
export function localTime(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 時刻[ms] → ローカルの 'yyyy-mm-dd HH:MM:SS'（CSV / NMEA の見出しで人が突き合わせる列）。
// null は空文字（CSV の空セル）にする。
export function localStamp(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${localTime(ms)}`;
}

// 割合(0〜1) → 百分率表示
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);

// 測定区間の受信品質（recorder.js が summary.rxStats に残す差分）→ 表示テキスト。
// 「受信機→Pico / Pico→アプリ で取りこぼしなく処理できたか」を1回の記録単位で示す。
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
// meta: { label, rxStats } — 保存済みセッションでも未保存の記録でも渡せる形にする。
// 停止理由はここには入れない。記録タブでは折りたたみの見出し（stopSummaryText）が
// 担当し、二重に出ないようにしている（仕様 3）。
export function formatStats(meta, st) {
  if (!st) return '有効なエポックが収集できませんでした';
  const fixLine = Object.entries(st.fixCounts).map(([q, n]) => `fix${q}:${n}`).join(' ');
  const rxText = rxStatsText(meta?.rxStats);
  return [
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

// Android内蔵GNSS との比較ブロック（DRMS 表示に formatStats の後ろへ付ける。仕様 5-4）。
// st: GNSS受信機の集計 / dst: computeDeviceStats の戻り値。
// accuracy は 68% 円半径で DRMS（1σ相当）とは定義が違うため、同じ行に並べず参考値として置く。
export function formatCompare(st, dst) {
  if (!st || !dst) return '';
  const ratio = st.drms > 0 && dst.drms != null ? `（${(dst.drms / st.drms).toFixed(1)}倍）` : '';
  const off = dst.offsetFromRef;
  const lines = [
    `── 比較: ${DEVICE}（同時取得 ${dst.count} 点 / 座標重複 ${dst.dupCount} 点）──`,
    `DRMS: ${GNSS} ${st.drms.toFixed(2)} m / ${DEVICE} ${fmt(dst.drms, 2)} m${ratio}`,
    `CEP50: ${GNSS} ${fmt(st.cep50, 2)} m / ${DEVICE} ${fmt(dst.cep50, 2)} m`,
    `CEP95: ${GNSS} ${fmt(st.cep95, 2)} m / ${DEVICE} ${fmt(dst.cep95, 2)} m`,
    `標準偏差(東西/南北): ${GNSS} ${st.stdEastM.toFixed(2)}/${st.stdNorthM.toFixed(2)} m / ` +
      `${DEVICE} ${fmt(dst.stdEastM, 2)}/${fmt(dst.stdNorthM, 2)} m`,
    `中心のズレ: ${fmt(off?.distM, 2)} m（${bearingText(off?.bearingDeg)}）※${GNSS}の中心からの相対。真の誤差ではない`,
    `${DEVICE}の平均 accuracy: ${fmt(dst.avgAccuracy, 1)} m（68%円半径。DRMS とは定義が異なる参考値）`,
  ];
  // 静止中は OS が更新を間引くことがあり、重複が多いとばらつきが過小評価される
  if (dst.count > 0 && dst.dupCount / dst.count >= 0.3) {
    lines.push(`※同じ座標の繰り返しが多く、${DEVICE}のばらつきを過小評価している可能性があります`);
  }
  lines.push(`※${DEVICE}は WiFi/基地局を融合した測位（Fused Location）で、GNSS 単独の性能ではありません`);
  return lines.join('\n');
}

// 2系統の測定区間と、その重なり（js/survey.js の window）。
// 「同じ地点・同じ時間に取れているか」を保存後・取込後でも確認できるようにするブロック。
export function formatWindow(window, summary) {
  if (!window) return '';
  const span = (w) =>
    w ? `${localTime(w.startedAt)}–${localTime(w.endedAt)}（${w.durationSec.toFixed(0)} 秒 / ${w.count} 点）` : '取得なし';
  const lines = [
    '── 測定区間（地点の対応確認）──',
    `${GNSS}: ${span(window.gnss)}` +
      (summary?.rawLines != null ? `　生NMEA ${summary.rawLines} 行` : '　生NMEA 未保存'),
    `${DEVICE}: ${span(window.device)}`,
  ];
  const ov = window.overlap;
  if (ov) {
    lines.push(
      `重なり: ${ov.overlapSec.toFixed(0)} 秒` +
        `（NMEA区間の ${pct(ov.coverGnss)} / Android区間の ${pct(ov.coverDevice)}）`
    );
    // OS が更新を間引くと内蔵は数点しか来ない。割合だけでは対応が判断できないため実数も出す。
    if (ov.deviceTotal != null) {
      lines.push(`${DEVICE}のうち記録区間内: ${ov.deviceInRecording} / ${ov.deviceTotal} 点`);
    }
  }
  if (window.clockOffsetMs != null) {
    lines.push(
      `端末時計 − GPS時刻: ${(window.clockOffsetMs / 1000).toFixed(1)} 秒` +
        '（2系統を同じ時間軸へ並べ直すときの補正量）'
    );
  }
  // Fused Location は数秒前に確定した fix を返すことがある。古いほど「同時刻の比較」から外れる。
  if (window.deviceLagMs != null) {
    lines.push(`${DEVICE}の測位の古さ: ${(window.deviceLagMs / 1000).toFixed(1)} 秒（受信時刻 − 測位確定時刻）`);
  }
  if (summary?.rawTruncated) {
    lines.push(`※生NMEAは上限に達したため ${summary.rawTruncated} 行を保存していません`);
  }
  return lines.join('\n');
}

// 測位結果テキスト（集計 → 2系統の比較 → 測定区間の対応）。
// 停止直後・保存済み・解析タブの3か所が同じ並びを出すので、組み立てはここに1本化する。
// window / summary を渡さなければ測定区間ブロックは出ない（ライブ表示）。
export function formatResult({ meta, stats, deviceStats, window, summary }) {
  return [
    formatStats(meta, stats),
    stats && deviceStats ? formatCompare(stats, deviceStats) : '',
    formatWindow(window, summary),
  ]
    .filter(Boolean)
    .join('\n');
}

// 散布図の表示範囲の外に出た点の件数（図では縁に▲で描かれている）。
// 記録タブ・解析タブが同じ表記で出す。outside は ScatterPlotView.update() の戻り値。
export function renderOutside(el, outside) {
  const parts = [];
  if (outside?.gnss) parts.push(`${GNSS} ${outside.gnss}点`);
  if (outside?.device) parts.push(`${DEVICE} ${outside.device}点`);
  el.hidden = !parts.length;
  el.textContent = parts.length ? `表示範囲の外側に ${parts.join(' / ')}（▲は方向）` : '';
}

// 保存済みセッション → formatStats / formatWindow / stopSummaryText に渡す meta
export function sessionMeta(session) {
  return {
    label: session.pointNo != null ? `${session.label}（No.${session.pointNo}）` : session.label,
    stopReason: session.summary?.stopReason,
    autoStop: session.summary?.autoStop,
    durationSec: session.window?.durationSec,
    count: session.summary?.count ?? 0,
    rxStats: session.summary?.rxStats,
    window: session.window,
    summary: session.summary,
  };
}

// 下書き行の見出し（地点名がまだ無いので時刻で識別する）。
// stopReason が無い＝停止処理が走らないまま落ちた記録。そうと分かるように書き分ける。
export function draftHeadText(session) {
  const time = localTime(session.endedAt ?? session.createdAt);
  return session.summary?.stopReason ? `${time} 停止` : `${time} まで（記録中に中断）`;
}

// 記録一覧の副見出しテキスト
export function sessionSubText(session) {
  const when = new Date(session.createdAt).toLocaleString('ja-JP');
  const s = session.summary;
  return (
    `${when}　${s?.count ?? 0}点` +
    (s?.drms != null ? `　DRMS ${s.drms.toFixed(2)}m` : '') +
    (s?.deviceDrms != null ? `（${DEVICE} ${s.deviceDrms.toFixed(2)}m）` : '') +
    (s?.lat != null ? `　(${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})` : '')
  );
}

// 記録一覧の2行目：2系統が揃っているかと生NMEAの有無（対応の確認をひと目で）
export function pairingSubText(session) {
  const s = session.summary;
  const w = session.window;
  const parts = [`${GNSS} ${s?.count ?? 0}点`];
  parts.push(s?.rawLines != null ? `生NMEA ${s.rawLines}行` : '生NMEAなし');
  parts.push(`${DEVICE} ${s?.deviceCount ?? 0}点`);
  if (w?.overlap?.deviceTotal != null) {
    parts.push(`区間内 ${w.overlap.deviceInRecording}/${w.overlap.deviceTotal}点`);
  }
  return parts.join(' / ');
}
