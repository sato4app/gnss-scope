// 開発用：ESモジュールの構文チェック＋純粋ロジック（パーサ/エポック/精度計算）の簡易テスト。
// 使い方: node tmp/check-syntax.mjs
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const jsDir = resolve(import.meta.dirname, '../js');
// DOM 依存のモジュールは import 時に window 等へ触らない設計だが、
// Leaflet グローバル L を参照しない純粋系のみ動作テストする。
let failed = 0;

for (const f of readdirSync(jsDir).filter((f) => f.endsWith('.js'))) {
  if (f === 'app.js') continue; // app.js はトップレベルで main() 実行のためスキップ（構文はSWAテストで担保）
  try {
    await import(pathToFileURL(resolve(jsDir, f)).href);
    console.log(`OK   ${f}`);
  } catch (e) {
    if (e instanceof SyntaxError) {
      failed++;
      console.error(`NG   ${f}: ${e.message}`);
    } else {
      // ReferenceError(window/document/navigator/indexedDB) は構文OKの証拠なので許容
      console.log(`OK   ${f} (実行時依存: ${e.constructor.name})`);
    }
  }
}

// app.js は import を試み、SyntaxError のみ NG 扱い（実行時のDOM依存エラーは許容）
try {
  await import(pathToFileURL(resolve(jsDir, 'app.js')).href).catch((e) => {
    if (e instanceof SyntaxError) throw e;
    console.log(`OK   app.js (実行時依存: ${e.constructor.name})`);
  });
} catch (e) {
  failed++;
  console.error(`NG   app.js: ${e.message}`);
}

// ---- 純粋ロジックの簡易テスト ----
const { parseSentence, validateChecksum, LineBuffer } = await import(pathToFileURL(resolve(jsDir, 'nmea.js')).href);
const { computeStaticStats, computeDeviceStats, offsetBetween, estimateHorizontalAccuracy, metersPerDegree, evaluateConvergence } =
  await import(pathToFileURL(resolve(jsDir, 'accuracy.js')).href);
const { holdDecision } = await import(pathToFileURL(resolve(jsDir, 'charts.js')).href);
const { formatStats, formatCompare, formatWindow, bearingText } = await import(
  pathToFileURL(resolve(jsDir, 'view-utils.js')).href
);
const {
  surveyIdOf, pointLabel, nextPointNo, timeWindow, windowOverlap, clockOffsetMs,
  groupBySurvey, surveySummary, pairingOf, countInWindow,
} = await import(pathToFileURL(resolve(jsDir, 'survey.js')).href);
const { compareRow, COMPARE_HEADER, importSessionFile } = await import(pathToFileURL(resolve(jsDir, 'file-io.js')).href);
const { Recorder, buildSummary, isInsufficient } = await import(pathToFileURL(resolve(jsDir, 'recorder.js')).href);
const { isConfirmed, isExported, sessionBytes } = await import(pathToFileURL(resolve(jsDir, 'storage.js')).href);
const { formatBytes } = await import(pathToFileURL(resolve(jsDir, 'photos.js')).href);
const { EpochAssembler } = await import(pathToFileURL(resolve(jsDir, 'epoch.js')).href);
const { StreamStats, diffRxStats } = await import(pathToFileURL(resolve(jsDir, 'stream-stats.js')).href);
// 系統名は js/constants.js が唯一の出所。表示文言のテストもそこを参照する
// （機種を替えて SERIES を書き換えたときに、テストだけ古い名前で落ちないようにする）。
const { SERIES, PHOTO_EDGE_OPTIONS, DEFAULT_SETTINGS } = await import(pathToFileURL(resolve(jsDir, 'constants.js')).href);
const { stopSummaryText } = await import(pathToFileURL(resolve(jsDir, 'view-utils.js')).href);

function assert(cond, msg) {
  if (cond) {
    console.log(`PASS ${msg}`);
  } else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
}

// チェックサム
const gga = '$GNGGA,123456.00,3451.2200,N,13528.3225,E,1,12,0.8,93.5,M,38.0,M,,*7A';
function cs(body) {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return body && `$${body}*${c.toString(16).toUpperCase().padStart(2, '0')}`;
}
const ggaLine = cs('GNGGA,123456.00,3451.2200,N,13528.3225,E,1,12,0.8,93.5,M,38.0,M,,');
assert(validateChecksum(ggaLine), 'チェックサム検証');
assert(!validateChecksum(ggaLine.slice(0, -1) + '0'), '不正チェックサムを棄却');

const p = parseSentence(ggaLine);
assert(p.valid && p.type === 'GGA', 'GGAパース');
assert(Math.abs(p.lat - (34 + 51.22 / 60)) < 1e-9, '緯度 ddmm→10進度変換');
assert(p.quality === 1 && p.numSV === 12 && p.hdop === 0.8 && p.alt === 93.5, 'GGAフィールド');

const gst = parseSentence(cs('GNGST,123456.00,2.5,,,,1.20,0.90,2.10'));
assert(gst.valid && gst.latStd === 1.2 && gst.lonStd === 0.9, 'GSTパース');

const vtg = parseSentence(cs('GNVTG,12.3,T,,M,0.05,N,0.09,K,A'));
assert(vtg.valid && vtg.speedKmh === 0.09 && vtg.course === 12.3, 'VTGパース');

// 精度推定
const accGst = estimateHorizontalAccuracy({ latStd: 3, lonStd: 4, hdop: 1 }, 5);
assert(accGst.value === 5 && accGst.source === 'GST', 'GST優先のDRMS');
const accDop = estimateHorizontalAccuracy({ latStd: null, lonStd: null, hdop: 1.2 }, 5);
assert(Math.abs(accDop.value - 6) < 1e-9 && accDop.source === 'HDOP×UERE', 'HDOP×UEREフォールバック');

// LineBuffer：チャンク分割の復元
const lb = new LineBuffer();
const out = [...lb.push('$GNGGA,1234'), ...lb.push('56.00,A*7F\n$GNR'), ...lb.push('MC,123456.00,A*68\n')];
assert(out.length === 2 && out[0].startsWith('$GNGGA') && out[1].startsWith('$GNRMC'), 'LineBuffer 断片結合');

// LineBuffer：溢れ破棄の通知（受信品質統計用。docs/algospec-202607.md 5.）
let discarded = 0;
const lbOv = new LineBuffer({ onDiscard: (n) => (discarded += n) });
lbOv.push('x'.repeat(5000)); // 行にならないゴミ
assert(discarded === 5000, 'LineBuffer 溢れ破棄を onDiscard で通知');

// ---- 受信品質統計（docs/algospec-202607.md 5.） ----

// $PPICO（Pico側カウンタ）のパース
const ppico = parseSentence(cs('PPICO,3,1200,2,1,1190,4'));
assert(
  ppico.valid && ppico.type === 'PPICO' && ppico.seq === 3 && ppico.rx === 1200 && ppico.ng === 2,
  '$PPICOパース: seq/rx/ng'
);
assert(ppico.drop === 1 && ppico.txok === 1190 && ppico.txng === 4, '$PPICOパース: drop/txok/txng');

// GSV の signalId 抽出（NMEA 4.10+ 末尾フィールド）
const gsvSig = parseSentence(cs('GPGSV,3,1,09,01,55,120,40,08,40,200,35,11,30,075,30,17,65,310,42,1'));
assert(gsvSig.valid && gsvSig.signalId === '1' && gsvSig.sats.length === 4, 'GSV signalId 抽出');

// EpochAssembler：GSV 部分欠落の検出（total=3 のうち msg2 が届かない）
const epochsOut = [];
const asm = new EpochAssembler({ onEpoch: (e) => epochsOut.push(e) });
asm.add(parseSentence(cs('GNGGA,100000.00,3451.2200,N,13528.3225,E,1,12,0.8,93.5,M,38.0,M,,')));
asm.add(parseSentence(cs('GPGSV,3,1,09,01,55,120,40,08,40,200,35,11,30,075,30,17,65,310,42,1')));
asm.add(parseSentence(cs('GPGSV,3,3,09,19,22,045,25,1')));
asm.flush();
assert(epochsOut.length === 1 && epochsOut[0].gsvMissing === 1, 'エポック: GSV部分欠落を検出');

// StreamStats：行の分類（解釈済み / チェックサムNG / 未対応）
const ss = new StreamStats();
ss.addLine(parseSentence(ggaLine)); // parsedOk
ss.addLine(parseSentence(ggaLine.slice(0, -1) + '0')); // csNg
ss.addLine(parseSentence(cs('GNZDA,123456.00,08,07,2026,,'))); // 未対応（計数のみ）
assert(ss.lines === 3 && ss.csNg === 1 && ss.parsedOk === 1 && ss.unknown === 1, 'StreamStats: 行分類');

// StreamStats：$PPICO 突合による BLE 欠落推定
const pp = (seq, txok) => parseSentence(cs(`PPICO,${seq},1000,2,0,${txok},1`));
assert(ss.addLine(pp(1, 100)) === true, 'StreamStats: $PPICO はエポックへ回さない');
for (let i = 0; i < 5; i++) ss.addLine(parseSentence(ggaLine)); // Pico 10行送信中 5行のみ届いた想定
ss.addLine(pp(2, 110));
assert(ss.bleLossEst === 4, 'StreamStats: BLE欠落の推定（Δtxok−Δ受信行数）');
ss.addLine(pp(4, 112)); // seq 3 が欠落
assert(ss.picoSeqGaps === 1, 'StreamStats: $PPICO 自体の欠落検出');
ss.addLine(pp(1, 5)); // カウンタ後退 = Pico 再起動
assert(ss.bleLossEst === 0, 'StreamStats: Pico再起動で基準を取り直す');

// StreamStats：エポックの時刻ギャップと GSV 欠落の集計
const ss2 = new StreamStats();
ss2.addEpoch({ time: { h: 10, m: 0, s: 0 }, gsvMissing: 0 });
ss2.addEpoch({ time: { h: 10, m: 0, s: 3 }, gsvMissing: 2 }); // 2秒分欠落
assert(ss2.epochs === 2 && ss2.epochGaps === 2 && ss2.gsvMissing === 2, 'StreamStats: エポックギャップ/GSV欠落');

// diffRxStats：測定区間（静的測位1回分）の差分
const dr = diffRxStats(
  { lines: 100, csNg: 2, parsedOk: 90, unknown: 1, discardedChars: 0, epochs: 50, epochGaps: 1, gsvMissing: 3, picoSeqGaps: 0, bleLossEst: 5, pico: { seq: 10, rx: 900, ng: 4, drop: 1, txok: 950, txng: 2 } },
  { lines: 40, csNg: 1, parsedOk: 35, unknown: 0, discardedChars: 0, epochs: 20, epochGaps: 0, gsvMissing: 1, picoSeqGaps: 0, bleLossEst: 2, pico: { seq: 4, rx: 400, ng: 1, drop: 0, txok: 420, txng: 0 } }
);
assert(dr.lines === 60 && dr.csNg === 1 && dr.bleLossEst === 3, 'diffRxStats: アプリ側の区間差分');
assert(dr.pico && dr.pico.rx === 500 && dr.pico.ng === 3 && dr.pico.drop === 1, 'diffRxStats: Pico側の区間差分');

// 静的測位の集計
const base = { lat: 34.8536, lon: 135.472, altMSL: 93, fixQuality: 1, hdop: 1, pdop: 1.5, vdop: 1.2, satsUsed: 10 };
const eps = [];
for (let i = 0; i < 100; i++) {
  eps.push({ ...base, lat: base.lat + (Math.random() - 0.5) * 2e-5, lon: base.lon + (Math.random() - 0.5) * 2e-5 });
}
const st = computeStaticStats(eps);
assert(st.count === 100, '集計: 点数');
assert(Math.abs(st.center.lat - base.lat) < 1e-5, '集計: 平均緯度');
assert(st.drms > 0 && st.cep50 > 0 && st.cep95 >= st.cep50, '集計: DRMS/CEP');
assert(st.offsets.length === 100, '集計: 散布図オフセット');
const { lonM } = metersPerDegree(35);
assert(Math.abs(lonM - 111320 * Math.cos((35 * Math.PI) / 180)) < 1e-6, 'm/度 換算');

// 衛星表示のキャリーフォワード判定（docs/algospec-202607.md 4.）
assert(holdDecision(true, 0, 8000) === 'draw', 'holdDecision: 衛星ありは常に描画');
assert(holdDecision(false, 3000, 8000) === 'hold', 'holdDecision: 失効時間内は保持');
assert(holdDecision(false, 8001, 8000) === 'clear', 'holdDecision: 失効超過はクリア');
assert(holdDecision(false, Infinity, 8000) === 'clear', 'holdDecision: 未受信（初期状態）はクリア');

// 収束判定（docs/algospec-202607.md 3.）
const CONV_OPTS = { minSec: 30, holdSec: 10, centerTolM: 0.3, drmsTolAbsM: 0.3, drmsTolPct: 0.05 };
const mkHistory = (n, fn) => Array.from({ length: n }, (_, i) => ({ t: i, ...fn(i) }));

// 横ばい列（中心固定・DRMS一定）→ stable
const flat = mkHistory(41, () => ({ lat: 34.8536, lon: 135.472, drms: 1.0 }));
assert(evaluateConvergence(flat, 40, CONV_OPTS).stable === true, '収束: 横ばい列で stable');

// ドリフト列（中心が毎秒 0.2 m 北へ移動 = 10秒で 2 m）→ centerMoveM 超過で not stable
const drift = mkHistory(41, (i) => ({ lat: 34.8536 + (i * 0.2) / 111320, lon: 135.472, drms: 1.0 }));
const convDrift = evaluateConvergence(drift, 40, CONV_OPTS);
assert(convDrift.stable === false && convDrift.centerMoveM > 0.3, '収束: ドリフト列で not stable');

// DRMS 変動列（窓内で 1 m 変動）→ drmsRangeM 超過で not stable
const drmsVar = mkHistory(41, (i) => ({ lat: 34.8536, lon: 135.472, drms: 1.0 + (i % 2) }));
const convDrms = evaluateConvergence(drmsVar, 40, CONV_OPTS);
assert(convDrms.stable === false && convDrms.drmsRangeM > 0.3, '収束: DRMS変動列で not stable');

// 時間不足（elapsedSec < minSec）→ not stable
assert(evaluateConvergence(flat.slice(0, 21), 20, CONV_OPTS).stable === false, '収束: 最低時間未満は not stable');

// 窓未充足（品質リセット後などで履歴が holdSec 未満）→ not stable
const short = mkHistory(5, (i) => ({ lat: 34.8536, lon: 135.472, drms: 1.0 })).map((h) => ({ ...h, t: 36 + h.t }));
const convShort = evaluateConvergence(short, 40, CONV_OPTS);
assert(convShort.stable === false && convShort.centerMoveM == null, '収束: 窓未充足は not stable');

// 進捗バーの2フェーズ（記録タブ）。フェーズ1は「連続良好データが溜まるまで」、
// フェーズ2は「窓は溜まったが中心・DRMS がまだ許容外」。この区別が付かないと
// バーが満タンのまま止まらない状態を説明できない。
assert(convShort.windowReady === false && convShort.stableSec === 4, '収束: フェーズ1は windowReady=false と経過秒');
assert(convDrift.windowReady === true && convDrift.stable === false, '収束: フェーズ2は windowReady=true でも未収束');
assert(convDrift.centerTolM === 0.3 && convDrift.drmsTolM >= 0.3, '収束: 判定ゲージ用に許容値も返す');
assert(evaluateConvergence([], 40, CONV_OPTS).stableSec === 0, '収束: 履歴なしは stableSec 0');
// DRMS 許容は絶対値と割合の大きい方（大きくばらつく場所で判定が厳しくなりすぎないように）
assert(
  evaluateConvergence(mkHistory(41, () => ({ lat: 34.8536, lon: 135.472, drms: 20 })), 40, CONV_OPTS).drmsTolM === 1,
  '収束: DRMS許容は絶対値と割合の大きい方'
);

// ---- 停止サマリ（記録タブの測位結果の見出し。js/view-utils.js） ----
// 「未収束」と「収束判定なし（自動停止OFF）」を書き分けること、
// 秒数と点数を併記して取りこぼし（BLE欠落・中断）が見えることを担保する。
assert(
  stopSummaryText({ stopReason: 'converged', durationSec: 45, count: 45, autoStop: true }) === '収束で自動停止（45秒/45点）',
  '停止サマリ: 収束は但し書きなし'
);
assert(
  stopSummaryText({ stopReason: 'timeout', durationSec: 180, count: 52, autoStop: true }) === '上限時間で停止（未収束: 180秒/52点）',
  '停止サマリ: 上限時間は未収束'
);
assert(
  stopSummaryText({ stopReason: 'maxEpochs', durationSec: 150, count: 300, autoStop: true }).startsWith('上限エポックで停止'),
  '停止サマリ: 上限エポック'
);
assert(
  stopSummaryText({ stopReason: 'manual', durationSec: 20, count: 20, autoStop: false }) === '手動停止（収束判定なし: 20秒/20点）',
  '停止サマリ: 自動停止OFFは「収束判定なし」'
);
assert(
  stopSummaryText({ stopReason: 'interrupted', durationSec: 30, count: 11, autoStop: true }) === '中断で停止（未収束: 30秒/11点）',
  '停止サマリ: 中断停止'
);
assert(
  stopSummaryText({ stopReason: 'manual', durationSec: 30, count: 0, autoStop: true }) === '測位データなしで停止（30秒/0点）',
  '停止サマリ: 有効エポック0'
);
assert(stopSummaryText({ durationSec: 10, count: 10 }).startsWith('手動停止'), '停止サマリ: 停止理由なしの旧データは手動停止扱い');

// ---- 調査日 → 地点 のツリー（js/survey.js） ----

// ID 体系：1日に何十地点まわっても survey_id + point_no で地点を一意に指せること
assert(surveyIdOf(new Date(2026, 6, 8, 9, 30).getTime()) === '2026-07-08', '調査日ID: ローカル日付');
assert(pointLabel('2026-07-08', 3) === '2026-07-08-03', '地点名: 調査日＋2桁連番');
assert(nextPointNo([], '2026-07-08') === 1, '地点番号: 初回は1');
assert(
  nextPointNo(
    [{ surveyId: '2026-07-08', pointNo: 1 }, { surveyId: '2026-07-08', pointNo: 2 }, { surveyId: '2026-07-07', pointNo: 9 }],
    '2026-07-08'
  ) === 3,
  '地点番号: 同じ調査日の最大＋1（他日は数えない）'
);
assert(nextPointNo([{ surveyId: '2026-07-08', pointNo: 5 }], '2026-07-08') === 6, '地点番号: 欠番は再利用しない');

// 測定区間（2系統が同じ時間に取れているかの検証材料）
const win = timeWindow([{ t: 1000 }, { t: 5000 }, { t: 3000 }]);
assert(win.startedAt === 1000 && win.endedAt === 5000 && win.durationSec === 4 && win.count === 3, '測定区間: 範囲と点数');
assert(timeWindow([]) === null, '測定区間: 0件は null');
assert(timeWindow([{ t: 1, recvAt: 9 }], (s) => s.recvAt).startedAt === 9, '測定区間: 見る時刻フィールドを選べる');

const ov = windowOverlap({ startedAt: 0, endedAt: 100000 }, { startedAt: 50000, endedAt: 150000 });
assert(ov.overlapSec === 50 && Math.abs(ov.coverGnss - 0.5) < 1e-9, '区間の重なり: 秒数とカバー率');
assert(windowOverlap({ startedAt: 0, endedAt: 1000 }, { startedAt: 5000, endedAt: 6000 }).overlapSec === 0, '区間の重なり: 離れていれば0');
assert(windowOverlap(null, win) === null, '区間の重なり: 片方なしは null');

// Android が1点しか来ない場合（OS が静止中の更新を間引く）でも対応を判断できること
const onePoint = windowOverlap({ startedAt: 0, endedAt: 60000 }, { startedAt: 30000, endedAt: 30000 });
assert(onePoint.coverDevice === 1, '区間の重なり: 1点だけでも相手の区間内なら100%');
assert(onePoint.coverGnss === 0, '区間の重なり: 1点では相手の区間はほぼ覆えない');
const outside = windowOverlap({ startedAt: 0, endedAt: 60000 }, { startedAt: 90000, endedAt: 90000 });
assert(outside.coverDevice === 0, '区間の重なり: 1点が区間外なら0%');
assert(countInWindow([{ t: 5 }, { t: 50 }, { t: 500 }], { startedAt: 0, endedAt: 100 }) === 2, '区間内の件数を数える');

// 端末時計 − GPS時刻（2系統を同じ時間軸へ並べ直すための補正量）
assert(clockOffsetMs([{ t: 1000, recvAt: 1200 }, { t: 2000, recvAt: 2300 }, { t: 3000, recvAt: 3200 }]) === 200, '時計オフセット: 中央値');
assert(clockOffsetMs([{ t: 1000 }]) === null, '時計オフセット: 対にならなければ null');

// 調査日でのグループ化と集計
const treeSessions = [
  { id: 'a', surveyId: '2026-07-08', pointNo: 2, createdAt: 2, summary: { count: 10, deviceCount: 5, drms: 1, deviceDrms: 3 } },
  { id: 'b', surveyId: '2026-07-08', pointNo: 1, createdAt: 1, summary: { count: 10, deviceCount: 0, drms: 3 } },
  { id: 'c', surveyId: '2026-07-09', pointNo: 1, createdAt: 3, summary: { count: 10, deviceCount: 2 } },
];
const groups = groupBySurvey(treeSessions);
assert(groups.length === 2 && groups[0].surveyId === '2026-07-09', 'グループ化: 新しい調査日が先');
assert(groups[1].sessions.map((s) => s.pointNo).join() === '1,2', 'グループ化: 日内は地点番号順');
const svSum = surveySummary(groups[1].sessions);
assert(svSum.points === 2 && svSum.both === 1 && svSum.gnssOnly === 1, '調査日集計: 2系統が揃った地点数');
assert(Math.abs(svSum.avgDrms - 2) < 1e-9, '調査日集計: 平均DRMS');
assert(pairingOf({ count: 0, deviceCount: 3 }) === 'deviceOnly', '対応状況: Androidのみ');
assert(pairingOf({ count: 5, deviceCount: 3 }) === 'both', '対応状況: 両系統あり');

// 測定区間の表示テキスト
const winText = formatWindow(
  { startedAt: 0, endedAt: 60000, durationSec: 60, gnss: { startedAt: 0, endedAt: 60000, durationSec: 60, count: 60 }, device: { startedAt: 10000, endedAt: 60000, durationSec: 50, count: 20 }, overlap: { overlapSec: 50, coverGnss: 0.83, coverDevice: 1 }, clockOffsetMs: 300 },
  { rawLines: 900 }
);
assert(
  winText.includes(SERIES.gnss.label) && winText.includes(SERIES.device.label) && winText.includes('重なり'),
  '区間テキスト: 2系統と重なりを出す'
);
assert(
  formatWindow(
    { startedAt: 0, endedAt: 60000, durationSec: 60, gnss: { startedAt: 0, endedAt: 60000, durationSec: 60, count: 60 }, device: { startedAt: 30000, endedAt: 30000, durationSec: 0, count: 1 }, overlap: { overlapSec: 0, coverGnss: 0, coverDevice: 1, deviceInRecording: 1, deviceTotal: 1 } },
    null
  ).includes('記録区間内: 1 / 1 点'),
  '区間テキスト: Android が1点でも区間内かどうかを出す'
);
assert(winText.includes('生NMEA 900 行'), '区間テキスト: 生NMEAの行数');
assert(formatWindow(null, null) === '', '区間テキスト: window なしは空');

// 使用衛星の平均 C/N0（記録データの受信強度の目安）
const snrStats = computeStaticStats([
  { lat: 34.85, lon: 135.47, satellites: [{ used: true, snr: 40 }, { used: false, snr: 10 }] },
  { lat: 34.85, lon: 135.47, satellites: [{ used: true, snr: 30 }] },
]);
assert(Math.abs(snrStats.avgSnrUsed - 35) < 1e-9, '集計: 使用衛星の平均C/N0（未使用衛星は除く）');
assert(formatStats({ label: '未保存の記録' }, snrStats).includes('DRMS'), '集計テキスト: 未保存の記録でも生成できる');
// 停止理由は測位結果の見出し（stopSummaryText）が持つ。集計テキストにも出すと二重になる
assert(
  !formatStats({ label: 'x', stopReason: 'converged' }, snrStats).includes('自動停止'),
  '集計テキスト: 停止理由は含めない（見出しと二重にしない）'
);

// ---- 記録フロー（record → stop → save） ----
// 保存先の擬似ストア（storage.js と同じ呼び出し面・同じ結合規則を持たせる）。
// failAppend を立てると追記が失敗する（記録中の書き込み失敗の挙動を確かめるため）。
function makeFakeStorage() {
  const db = { surveys: new Map(), sessions: new Map(), points: new Map(), chunks: new Map(), photos: new Map() };
  const bySession = (map, sid) => [...map.values()].filter((v) => v.sessionId === sid);
  const store = {
    db,
    failAppend: false,
    ensureSurvey: async (id, createdAt) => {
      const cur = db.surveys.get(id) || { id, label: id, memo: '', createdAt };
      db.surveys.set(id, { ...cur, updatedAt: Date.now() });
      return db.surveys.get(id);
    },
    getSession: async (id) => db.sessions.get(id) || null,
    getSessionsBySurvey: async (id) => [...db.sessions.values()].filter((s) => s.surveyId === id),
    getPointRecords: async (sid) => bySession(db.points, sid),
    getChunkKeys: async (sid) => bySession(db.chunks, sid).map((c) => c.id),
    getPhotoKeys: async (sid) => bySession(db.photos, sid).map((c) => c.id),
    getPhotos: async (sid) => bySession(db.photos, sid).sort((a, b) => a.addedAt - b.addedAt),
    touchSurvey: async (id) => {
      const sv = db.surveys.get(id);
      if (sv) db.surveys.set(id, { ...sv, updatedAt: Math.max(Date.now(), (sv.updatedAt || 0) + 1) });
    },
    markExported: async (id) => {
      const sv = db.surveys.get(id);
      if (sv) db.surveys.set(id, { ...sv, exportedAt: Date.now() });
    },
    // 写真：枚数とバイト数を session 側にも持たせる（一覧・容量集計で引き直さないため）
    addPhoto: async (sid, { blob, w, h }) => {
      const session = db.sessions.get(sid);
      const seq = bySession(db.photos, sid).length + 1;
      const photo = { id: `${sid}_ph${seq}`, sessionId: sid, seq, blob, bytes: blob.size, w, h, addedAt: Date.now() + seq };
      db.photos.set(photo.id, photo);
      db.sessions.set(sid, {
        ...session,
        summary: {
          ...session.summary,
          photoCount: (session.summary?.photoCount || 0) + 1,
          photoBytes: (session.summary?.photoBytes || 0) + photo.bytes,
        },
      });
      await store.touchSurvey(session.surveyId);
      return photo;
    },
    deletePhoto: async (sid, photoId) => {
      const session = db.sessions.get(sid);
      const target = db.photos.get(photoId);
      if (!session || !target) return;
      db.photos.delete(photoId);
      db.sessions.set(sid, {
        ...session,
        summary: {
          ...session.summary,
          photoCount: Math.max(0, (session.summary?.photoCount || 0) - 1),
          photoBytes: Math.max(0, (session.summary?.photoBytes || 0) - target.bytes),
        },
      });
      await store.touchSurvey(session.surveyId);
    },
    getStorageUsage: async () => {
      let total = 0;
      let unexported = 0;
      for (const s of db.sessions.values()) {
        const bytes = sessionBytes(s);
        total += bytes;
        if (!isExported(db.surveys.get(s.surveyId))) unexported += bytes;
      }
      return { total, unexported };
    },
    getSurvey: async (id) => db.surveys.get(id) || null,
    createDraft: async ({ id, startedAt, surveyId }) => {
      await store.ensureSurvey(surveyId, startedAt);
      const session = {
        id, type: 'record', status: 'draft', surveyId, pointNo: null,
        label: '', memo: '', createdAt: startedAt, summary: { count: 0, rawLines: null },
      };
      const point = { id: `${id}_p`, sessionId: id, surveyId, pointNo: null, kind: 'record' };
      db.sessions.set(id, session);
      db.points.set(point.id, point);
      return { session, point };
    },
    appendChunk: async (sessionId, seq, data, progress) => {
      if (store.failAppend) throw new Error('quota');
      db.chunks.set(`${sessionId}_${seq}`, { id: `${sessionId}_${seq}`, sessionId, seq, ...data });
      const s = db.sessions.get(sessionId);
      if (s) db.sessions.set(sessionId, { ...s, ...progress, summary: { ...s.summary, ...progress.summary } });
    },
    finishDraft: async (sessionId, { stats, deviceStats, summary, window, endedAt }) => {
      const s = db.sessions.get(sessionId);
      if (!s) return null;
      const next = { ...s, endedAt, window, summary };
      db.sessions.set(sessionId, next);
      for (const p of bySession(db.points, sessionId)) {
        db.points.set(p.id, { ...p, stats, ...(deviceStats ? { deviceStats } : {}) });
      }
      return next;
    },
    confirmDraft: async (sessionId, { stats, deviceStats, ...patch }) => {
      const s = db.sessions.get(sessionId);
      const next = { ...s, ...patch, status: 'confirmed', confirmedAt: Date.now() };
      db.sessions.set(sessionId, next);
      for (const p of bySession(db.points, sessionId)) {
        db.points.set(p.id, {
          ...p, pointNo: next.pointNo, ...(stats ? { stats } : {}), ...(deviceStats ? { deviceStats } : {}),
        });
      }
      await store.ensureSurvey(next.surveyId, next.createdAt);
      return next;
    },
    deleteSession: async (id) => {
      db.sessions.delete(id);
      for (const p of bySession(db.points, id)) db.points.delete(p.id);
      for (const c of bySession(db.chunks, id)) db.chunks.delete(c.id);
      for (const f of bySession(db.photos, id)) db.photos.delete(f.id);
    },
    // チャンクを seq 順に結合して従来と同じ形の point を返す（storage.js と同じ規則）
    getPointsBySession: async (sid) => {
      const points = bySession(db.points, sid);
      if (!points.length) return [];
      const chunks = bySession(db.chunks, sid).sort((a, b) => a.seq - b.seq);
      const samples = [];
      const rawNmea = [];
      const deviceSamples = [];
      let hasRaw = false;
      for (const c of chunks) {
        if (c.samples) samples.push(...c.samples);
        if (c.deviceSamples) deviceSamples.push(...c.deviceSamples);
        if (c.rawNmea) {
          hasRaw = true;
          rawNmea.push(...c.rawNmea);
        }
      }
      const point = { ...points[0], samples };
      if (hasRaw) point.rawNmea = rawNmea;
      if (deviceSamples.length) point.deviceSamples = deviceSamples;
      return [point, ...points.slice(1)];
    },
    putImported: async (session, point, data) => {
      db.sessions.set(session.id, session);
      db.points.set(point.id, point);
      db.chunks.set(`${session.id}_0`, { id: `${session.id}_0`, sessionId: session.id, seq: 0, ...data });
    },
  };
  return store;
}

// 記録の id は `rec_<開始ms>`。テストは連続で走るので、記録の合間に時計を進めておく
// （実機では下書きの作成に IndexedDB のトランザクションが挟まるため 1ms 未満にはならない）。
const tick = () => new Promise((r) => setTimeout(r, 2));

// 下書きを確定する（record-ui.js の confirmDraft と同じ手順。確定済みだけを見て採番する）
async function confirmDraft(store, sessionId, label = '', memo = '') {
  const session = await store.getSession(sessionId);
  const siblings = (await store.getSessionsBySurvey(session.surveyId)).filter(isConfirmed);
  const pointNo = nextPointNo(siblings, session.surveyId);
  const next = await store.confirmDraft(sessionId, {
    pointNo,
    label: label || pointLabel(session.surveyId, pointNo),
    memo,
  });
  return { session: next, point: (await store.getPointsBySession(sessionId))[0] };
}

const mkEpoch = (i, base = 34.8536) => ({
  t: new Date(Date.UTC(2026, 6, 8, 1, 0, i)),
  recvAt: Date.now(),
  lat: base + (i % 2) * 1e-6,
  lon: 135.472,
  altMSL: 93,
  fixQuality: 1,
  fixMode: 3,
  satsUsed: 10,
  satsInView: 14,
  pdop: 1.5,
  hdop: 0.9,
  vdop: 1.2,
  satellites: [{ sys: 'gps', prn: 1, elev: 55, azim: 120, snr: 40, used: true }],
});

const fakeStorage = makeFakeStorage();
const rec = new Recorder(fakeStorage);
await rec.start({ maxSec: 0, maxEpochs: 0, autoStop: false, minSec: 0 }); // 上限なし = 手動停止のみ
const draftId = rec.currentId;
assert(fakeStorage.db.sessions.get(draftId)?.status === 'draft', '記録: 開始時に下書きを作る');
assert(fakeStorage.db.sessions.get(draftId).pointNo === null, '記録: 下書きは地点番号を採らない');
assert(fakeStorage.db.surveys.size === 1, '記録: 開始時に調査日（ツリーの根）を用意する');

rec.addRawLine(ggaLine);
rec.addRawLine(cs('GNRMC,010000.00,A,3451.2200,N,13528.3225,E,0.0,0.0,080726,,,A'));
for (let i = 0; i < 10; i++) rec.addEpoch(mkEpoch(i));
await Promise.resolve(); // 追記は await しないで走らせるので、擬似ストアの解決を待つ
assert(fakeStorage.db.chunks.size === 2, '記録: 5エポックごとにチャンクを追記する');
assert(fakeStorage.db.sessions.get(draftId).summary.count === 10, '記録: 追記のたびに進捗（点数）を下書きへ残す');

const pending = rec.stop('manual');
assert(pending.stats.count === 10 && pending.stopReason === 'manual', '記録: stop で集計する');
await rec.settled();
const stopped = await fakeStorage.getSession(draftId);
assert(stopped.status === 'draft', '記録: 停止しても下書きのまま（保存で確定する）');
assert(stopped.summary.count === 10 && stopped.summary.drms >= 0, '記録: 停止時に summary へ集計値を書く');

const draftPoint = (await fakeStorage.getPointsBySession(draftId))[0];
assert(draftPoint.samples.length === 10, '記録: チャンクを結合すると全エポックが揃う');
assert(draftPoint.samples[0].satellites.length === 1, '記録: サンプルに衛星リストを残す（後からSkyPlot/SNR再現用）');
assert(draftPoint.samples[0].recvAt != null, '記録: サンプルに端末時計(recvAt)も残す（2系統の突合用）');
assert(draftPoint.rawNmea.length === 2, '記録: 生NMEA行をそのまま蓄積する');
assert(pending.window.gnss.count === 10 && pending.window.device === null, '記録: NMEA側の測定区間を残す');
assert(pending.window.gnssUtc.startedAt === Date.UTC(2026, 6, 8, 1, 0, 0), '記録: GPS時刻での区間も残す');

const entry = await confirmDraft(fakeStorage, draftId, 'テスト地点', 'メモ');
assert(entry.session.status === 'confirmed' && entry.session.type === 'record', '記録: 保存で確定済みになる');
assert(entry.point.kind === 'record' && entry.point.samples.length === 10, '記録: 確定後も実データはチャンクから読める');
assert(entry.session.label === 'テスト地点' && entry.session.memo === 'メモ', '記録: 地点名・メモは確定時に付与');
assert(
  entry.session.surveyId === surveyIdOf(pending.startedAt) && entry.session.pointNo === 1,
  '記録: 確定で地点番号を採番する'
);
assert(entry.point.surveyId === entry.session.surveyId && entry.point.pointNo === 1, '記録: 葉（point）にも地点番号を複写する');
assert(entry.session.summary.rawLines === 2, '記録: 生NMEAの件数を summary に残す');

// 同じ調査日に続けて記録すると地点番号が増える（1日に何十地点もまわる運用）
const rec1b = new Recorder(fakeStorage);
await tick();
await rec1b.start({ maxSec: 0, maxEpochs: 0, autoStop: false, minSec: 0 });
const draft1b = rec1b.currentId;
rec1b.addEpoch(mkEpoch(0, 34.86));
rec1b.stop('manual');
await rec1b.settled();
const entry1b = await confirmDraft(fakeStorage, draft1b);
assert(entry1b.session.pointNo === 2, '記録: 同じ調査日の次の記録は地点 No.2');
assert(entry1b.session.label === pointLabel(entry1b.session.surveyId, 2), '記録: 既定の地点名は調査日＋連番');

// 下書きは地点番号を消費しない（測り直しても番号が飛ばない）
const recDraft = new Recorder(fakeStorage);
await tick();
await recDraft.start({ maxSec: 0, maxEpochs: 0, autoStop: false, minSec: 0 });
const abandoned = recDraft.currentId;
recDraft.addEpoch(mkEpoch(0, 34.88));
recDraft.stop('manual');
await recDraft.settled();
const siblingsWithDraft = await fakeStorage.getSessionsBySurvey(surveyIdOf(Date.now()));
assert(
  nextPointNo(siblingsWithDraft.filter(isConfirmed), surveyIdOf(Date.now())) === 3,
  '記録: 下書きは地点番号を消費しない'
);
await fakeStorage.deleteSession(abandoned);
assert(fakeStorage.db.chunks.size > 0, '記録: 他の地点のチャンクは残る');
assert(
  [...fakeStorage.db.chunks.values()].every((c) => c.sessionId !== abandoned),
  '記録: 下書きを削除するとチャンクも消える'
);

// 有効エポック 0 点の記録は下書きごと片付ける（復元しても使えないため）
const recEmpty = new Recorder(fakeStorage);
await tick();
await recEmpty.start({ maxSec: 0, maxEpochs: 0, autoStop: false, minSec: 0 });
const emptyId = recEmpty.currentId;
recEmpty.addRawLine(ggaLine);
const pendingEmpty = recEmpty.stop('stalled');
assert(pendingEmpty.stats === null, '記録: 0点の停止は集計値を持たない');
await recEmpty.settled();
assert(!fakeStorage.db.sessions.has(emptyId), '記録: 0点の記録は下書きごと削除する');

// 生NMEA保存 OFF のときは行を集めず、point にキーも作らない
const rec1c = new Recorder(fakeStorage);
await tick();
await rec1c.start({ maxSec: 0, maxEpochs: 0, autoStop: false, minSec: 0, saveRaw: false });
const draft1c = rec1c.currentId;
rec1c.addRawLine(ggaLine);
rec1c.addEpoch(mkEpoch(0, 34.87));
const pending1c = rec1c.stop('manual');
assert(pending1c.summary.rawLines === null, '記録: 生NMEA保存 OFF なら行を集めない');
await rec1c.settled();
const point1c = (await fakeStorage.getPointsBySession(draft1c))[0];
assert(!('rawNmea' in point1c), '記録: OFF の記録に rawNmea キーを作らない');

// 追記が失敗しても収集済みを捨てず、続けて失敗したら打ち切る
const failStore = makeFakeStorage();
const recFail = new Recorder(failStore);
await recFail.start({ maxSec: 0, maxEpochs: 0, autoStop: false, minSec: 0 });
failStore.failAppend = true;
for (let i = 0; i < 15; i++) recFail.addEpoch(mkEpoch(i, 34.9));
await new Promise((r) => setTimeout(r, 0));
assert(failStore.db.chunks.size === 0, '記録: 追記に失敗したらチャンクは残らない');
assert(!recFail.isRecording, '記録: 追記が連続 3 回失敗したら打ち切る');

// ---- 端末内のデータ量（自前で数える） ----
// 記録データの実量だけを数えたいので、navigator.storage.estimate（オリジン全体＝
// 地図タイル込み）ではなく、書き込むときに数えた概算値を積む。
const sized = await fakeStorage.getSession(draftId);
assert(sized.summary.bytes > 0, '容量: 停止時に summary へ概算バイト数を残す');
assert(sessionBytes(sized) === sized.summary.bytes, '容量: 写真が無ければ実データぶんだけ');
assert(formatBytes(0) === '0 MB' && formatBytes(512 * 1024).endsWith('KB'), '容量: 1MB 未満は KB 表示');
assert(formatBytes(52 * 1024 * 1024) === '52.0 MB', '容量: MB 表示');

// 写真の長辺は決め打ちの選択肢から選ぶ（自由入力にしない）
assert(PHOTO_EDGE_OPTIONS.length === 3 && PHOTO_EDGE_OPTIONS.every((v) => v > 0), '写真: 長辺の選択肢を持つ');
assert(PHOTO_EDGE_OPTIONS.includes(DEFAULT_SETTINGS.photoMaxEdge), '写真: 既定の長辺は選択肢のどれか');

// 書き出し記録：書き出した後に地点や写真が増えれば「未書き出し」に戻る
const usageSurvey = sized.surveyId;
assert(!isExported(fakeStorage.db.surveys.get(usageSurvey)), '書き出し: 既定は未書き出し');
await fakeStorage.markExported(usageSurvey);
assert(isExported(fakeStorage.db.surveys.get(usageSurvey)), '書き出し: markExported で書き出し済みになる');
const usageAfterExport = await fakeStorage.getStorageUsage();
assert(usageAfterExport.unexported === 0, '書き出し: 書き出し済みは未書き出し量に数えない');

// 写真：枚数とバイト数を session 側に持ち、削除で戻る
const fakeBlob = { size: 200 * 1024 };
await fakeStorage.addPhoto(draftId, { blob: fakeBlob, w: 1280, h: 960 });
await fakeStorage.addPhoto(draftId, { blob: fakeBlob, w: 1280, h: 960 });
const withPhotos = await fakeStorage.getSession(draftId);
assert(withPhotos.summary.photoCount === 2, '写真: 枚数を session に持つ');
assert(sessionBytes(withPhotos) === withPhotos.summary.bytes + 400 * 1024, '写真: 容量に写真ぶんを足す');
assert(!isExported(fakeStorage.db.surveys.get(usageSurvey)), '写真: 追加すると未書き出しに戻る');
const photoList = await fakeStorage.getPhotos(draftId);
await fakeStorage.deletePhoto(draftId, photoList[0].id);
const afterPhotoDel = await fakeStorage.getSession(draftId);
assert(afterPhotoDel.summary.photoCount === 1, '写真: 削除で枚数が戻る');
assert(afterPhotoDel.summary.photoBytes === 200 * 1024, '写真: 削除でバイト数も戻る');

// 地点を消せば写真も消える
const photoOnlyId = draftId;
await fakeStorage.deleteSession(photoOnlyId);
assert([...fakeStorage.db.photos.values()].every((f) => f.sessionId !== photoOnlyId), '写真: 地点を消すと写真も消える');

// データ不足の判定（30 秒以上で 10 点未満なら破棄を確認する）
assert(isInsufficient({ durationSec: 30, count: 3 }), 'データ不足: 30秒で3点は不足');
assert(!isInsufficient({ durationSec: 30, count: 10 }), 'データ不足: 10点あれば確認しない');
assert(!isInsufficient({ durationSec: 20, count: 3 }), 'データ不足: 30秒未満は確認しない（意図的な手動停止）');
assert(!isInsufficient({ durationSec: 60, count: 0 }), 'データ不足: 0点は別扱い（確認せず削除）');
assert(buildSummary({ stats: null, stopReason: 'stalled' }).count === 0, 'summary: 集計なしでも停止理由は残す');

// ---- 端末内蔵GNSS の並行取得と比較（仕様 4-8 / 5-4） ----

// 中心どうしのズレ（東西/南北・距離・方位）
const { latM } = metersPerDegree(34.85);
const off = offsetBetween({ lat: 34.85, lon: 135.47 }, { lat: 34.85 + 10 / latM, lon: 135.47 });
assert(Math.abs(off.distM - 10) < 1e-6 && Math.abs(off.bearingDeg) < 1e-6, 'offsetBetween: 真北 10 m');
assert(bearingText(off.bearingDeg) === '北' && bearingText(45) === '北東', '方位の日本語表記');

// 端末内蔵GNSS の集計：座標重複の計数・平均 accuracy・基準中心からのズレ
const devSamples = [
  { t: 1, lat: 34.8536, lon: 135.472, accuracy: 5 },
  { t: 2, lat: 34.8536, lon: 135.472, accuracy: 5 }, // 直前と同一座標（OSの間引き）
  { t: 3, lat: 34.85362, lon: 135.47202, accuracy: 3 },
];
const devStats = computeDeviceStats(devSamples, { lat: 34.8536, lon: 135.472 });
assert(devStats.count === 3 && devStats.dupCount === 1, '内蔵GNSS集計: 点数と座標重複');
assert(Math.abs(devStats.avgAccuracy - 13 / 3) < 1e-9, '内蔵GNSS集計: 平均accuracy');
assert(devStats.offsetFromRef.distM > 0, '内蔵GNSS集計: 基準中心からのズレ');
assert(computeDeviceStats([], { lat: 34.8536, lon: 135.472 }) === null, '内蔵GNSS集計: 0件は null');

// 比較テキスト（重複が多いと過小評価の注意を出す）
const cmpText = formatCompare(snrStats, devStats);
assert(cmpText.includes(`比較: ${SERIES.device.label}`) && cmpText.includes('中心のズレ'), '比較テキスト: 主要行');
assert(cmpText.includes('過小評価'), '比較テキスト: 座標重複が多いと注意を出す');
assert(formatCompare(snrStats, null) === '', '比較テキスト: 比較データなしは空');

// 記録フロー：並行取得ありの record → stop → save
const fakeDevice = { started: 0, stopped: 0, status: 'watching', start() { this.started++; }, stop() { this.stopped++; }, setPaused() {} };
const rec2 = new Recorder(fakeStorage, { deviceGnss: fakeDevice });
await tick();
await rec2.start({ maxSec: 0, maxEpochs: 0, autoStop: false, minSec: 0, withDevice: true });
const draft2 = rec2.currentId;
assert(fakeDevice.started === 1, '記録: withDevice で内蔵GNSSの取得を開始する');
// Android は「OSが測位を確定した時刻(t)」と「アプリが受け取った時刻(recvAt)」が数秒ずれる。
// 区間の突き合わせは recvAt 側で行う（M10S の recvAt と同じ役割）。
const t0 = Date.now();
rec2.addDeviceSample({ t: t0 - 2500, recvAt: t0, lat: 34.8536, lon: 135.472, accuracy: 4 });
rec2.addDeviceSample({ t: t0 - 1500, recvAt: t0 + 1000, lat: 34.85361, lon: 135.47201, accuracy: 4 });
for (let i = 0; i < 3; i++) {
  rec2.addEpoch({ t: new Date(), recvAt: t0 + i * 1000, lat: 34.8536 + i * 1e-6, lon: 135.472, fixQuality: 1, fixMode: 3, satsUsed: 10 });
}
const pending2 = rec2.stop('manual');
assert(fakeDevice.stopped === 1, '記録: stop で内蔵GNSSの取得を止める');
assert(pending2.deviceStats.count === 2, '記録: 内蔵GNSSを同区間で集計する');
assert(pending2.deviceStats.offsetFromRef != null, '記録: 内蔵GNSSの中心ズレは M10S 中心を基準にする');
assert(pending2.window.device.count === 2 && pending2.window.overlap.overlapSec === 1, '記録: 2系統の区間の重なりを残す');
assert(pending2.window.overlap.coverDevice === 1, '記録: Android 区間は NMEA 区間に収まっている');
// 記録区間（record→stop）が基準。NMEA の最初のエポックは確定までに1秒強かかるため、
// エポック範囲ではなく記録区間で数えないと開始直後の Android サンプルを取りこぼす。
const devInRec = [t0, t0 + 1000].filter((t) => t >= pending2.startedAt && t <= pending2.endedAt).length;
assert(
  pending2.window.overlap.deviceInRecording === devInRec && pending2.window.overlap.deviceTotal === 2,
  '記録: Android のうち記録区間内にあった点数を残す'
);
assert(pending2.window.deviceLagMs === 2500, '記録: Android の測位の古さ（受信 − 測位確定）を残す');

await rec2.settled();
const entry2 = await confirmDraft(fakeStorage, draft2, '比較テスト');
assert(entry2.point.deviceSamples.length === 2 && entry2.point.deviceStats != null, '記録: 内蔵GNSSもチャンクへ保存する');
assert(entry2.session.summary.deviceDrms != null && entry2.session.summary.deviceCount === 2, '記録: summary に内蔵GNSSの比較値を残す');
assert(entry2.session.window?.overlap != null, '記録: 測定区間を session に残す（保存後も対応を検証できる）');

// ---- 調査日の対応表（1行1地点で NMEA と Android を並べる） ----
const row = compareRow(entry2.session, entry2.point);
assert(row[0] === entry2.session.surveyId && row[1] === entry2.session.pointNo, '対応表: 先頭は survey_id と point_no');
assert(row[2] === '比較テスト', '対応表: 地点名');
assert(row[8] === 3 && row[22] === 2, '対応表: NMEA のエポック数と Android のサンプル数を並べる');
assert(row.length === COMPARE_HEADER.length, '対応表: 列数がヘッダと一致');
assert(COMPARE_HEADER[35] === 'overlap_s' && row[35] === 1, '対応表: 区間の重なりを列に出す');

// 並行取得 OFF のときは従来どおりの形（余計なキーを増やさない）
const rec3 = new Recorder(fakeStorage, { deviceGnss: fakeDevice });
await tick();
await rec3.start({ maxSec: 0, maxEpochs: 0, autoStop: false, minSec: 0 });
const draft3 = rec3.currentId;
rec3.addDeviceSample({ t: 1, lat: 34.9, lon: 135.5, accuracy: 4 }); // withDevice でないので捨てる
rec3.addEpoch({ t: new Date(), recvAt: Date.now(), lat: 34.8536, lon: 135.472, fixQuality: 1, fixMode: 3, satsUsed: 10 });
const pending3 = rec3.stop('manual');
assert(pending3.deviceStats === null, '記録: OFF なら内蔵GNSSを集めない');
await rec3.settled();
const entry3 = await confirmDraft(fakeStorage, draft3, '比較なし');
assert(!('deviceStats' in entry3.point) && !('deviceDrms' in entry3.session.summary), '記録: OFF の記録の形は従来どおり');
assert(!('deviceSamples' in entry3.point), '記録: OFF の記録に deviceSamples キーを作らない');

// ---- 取込（単体 JSON / 調査日バンドル JSON） ----
const importStore = makeFakeStorage();
const mkSample = (i) => ({ t: Date.UTC(2026, 6, 8, 1, 0, i), recvAt: 1.7e12 + i * 1000, lat: 34.8536, lon: 135.472, fixQuality: 1 });
const jsonFile = (obj) => ({ text: async () => JSON.stringify(obj) });

const importedEntries = await importSessionFile(
  jsonFile({
    app: 'gnss-scope',
    format: 2,
    survey: { id: '2026-07-08', label: '2026-07-08' },
    points: [
      {
        session: { id: 'rec_1', surveyId: '2026-07-08', pointNo: 7, label: '2026-07-08-07', createdAt: Date.UTC(2026, 6, 8, 1, 0, 0) },
        point: { samples: [mkSample(0), mkSample(1)], rawNmea: [{ t: 1, line: ggaLine }] },
      },
      {
        session: { id: 'rec_2', surveyId: '2026-07-08', pointNo: 8, label: '2026-07-08-08', createdAt: Date.UTC(2026, 6, 8, 1, 5, 0) },
        point: { samples: [mkSample(2)], deviceSamples: [{ t: 1.7e12, lat: 34.8536, lon: 135.472, accuracy: 5 }] },
      },
    ],
  }),
  importStore
);
assert(importedEntries.length === 2, '取込: バンドルの全地点を復元する');
assert(importedEntries[0].session.pointNo === 1 && importedEntries[1].session.pointNo === 2, '取込: 地点番号は取込先で採り直す');
assert(importedEntries[0].session.sourceId === 'rec_1' && importedEntries[0].session.sourcePointNo === 7, '取込: 元の id と地点番号を残す');
assert(importedEntries[0].point.rawNmea.length === 1, '取込: 生NMEAも復元する');
assert(importedEntries[1].point.deviceStats != null, '取込: Android の集計を再計算する');
assert(importStore.db.surveys.has('2026-07-08'), '取込: 調査日（ツリーの根）を用意する');
assert(importedEntries[0].session.id !== importedEntries[1].session.id, '取込: 地点ごとに別の id を採番する');

// 単体 JSON（format 1）も同じ入口で読める
const singleImported = await importSessionFile(
  jsonFile({
    app: 'gnss-scope',
    format: 1,
    session: { id: 'rec_9', createdAt: Date.UTC(2026, 6, 9, 1, 0, 0), label: '単体' },
    point: { samples: [mkSample(0)] },
  }),
  importStore
);
assert(singleImported.length === 1 && singleImported[0].session.pointNo === 1, '取込: 単体JSONは1地点として読む');

// 中身が空の地点は理由付きで弾く
let importError = null;
try {
  await importSessionFile(jsonFile({ app: 'gnss-scope', format: 2, points: [{ session: {}, point: { samples: [] } }] }), importStore);
} catch (e) {
  importError = e.message;
}
assert(importError?.includes('0 件'), '取込: 生エポック0件は理由付きで弾く');

console.log(failed ? `\n${failed} 件失敗` : '\n全チェック OK');
process.exit(failed ? 1 : 0);
