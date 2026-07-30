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
const { computeStaticStats, estimateHorizontalAccuracy, metersPerDegree, evaluateConvergence } = await import(
  pathToFileURL(resolve(jsDir, 'accuracy.js')).href
);
const { holdDecision } = await import(pathToFileURL(resolve(jsDir, 'charts.js')).href);
const { nextPointLabel, formatStats } = await import(pathToFileURL(resolve(jsDir, 'view-utils.js')).href);
const { Recorder } = await import(pathToFileURL(resolve(jsDir, 'recorder.js')).href);
const { EpochAssembler } = await import(pathToFileURL(resolve(jsDir, 'epoch.js')).href);
const { StreamStats, diffRxStats } = await import(pathToFileURL(resolve(jsDir, 'stream-stats.js')).href);

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

// 既定地点名 yyyy-mm-dd-xx の連番（同日のみ数える）
const day = new Date(2026, 6, 8); // 2026-07-08
assert(nextPointLabel([], day) === '2026-07-08-01', '地点名: 初回は -01');
assert(nextPointLabel(['2026-07-08-01', '2026-07-08-02'], day) === '2026-07-08-03', '地点名: 連番の次');
assert(
  nextPointLabel(['2026-07-07-05', '任意ラベル', '2026-07-08-09'], day) === '2026-07-08-10',
  '地点名: 他日・任意ラベルは無視'
);

// 使用衛星の平均 C/N0（記録データの受信強度の目安）
const snrStats = computeStaticStats([
  { lat: 34.85, lon: 135.47, satellites: [{ used: true, snr: 40 }, { used: false, snr: 10 }] },
  { lat: 34.85, lon: 135.47, satellites: [{ used: true, snr: 30 }] },
]);
assert(Math.abs(snrStats.avgSnrUsed - 35) < 1e-9, '集計: 使用衛星の平均C/N0（未使用衛星は除く）');
assert(formatStats({ label: '未保存の記録' }, snrStats).includes('DRMS'), '集計テキスト: 未保存の記録でも生成できる');

// ---- 記録フロー（record → stop → save） ----
const savedDb = { sessions: [], points: [] };
const fakeStorage = {
  putSession: async (s) => savedDb.sessions.push(s) && s,
  putPoint: async (p) => savedDb.points.push(p) && p,
};
const rec = new Recorder(fakeStorage);
rec.start({ maxSec: 0, maxEpochs: 0, autoStop: false, minSec: 0 }); // 上限なし = 手動停止のみ
for (let i = 0; i < 10; i++) {
  rec.addEpoch({
    t: new Date(Date.UTC(2026, 6, 8, 1, 0, i)),
    recvAt: Date.now(),
    lat: 34.8536 + (i % 2) * 1e-6,
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
}
const pending = rec.stop('manual');
assert(pending.stats.count === 10 && pending.stopReason === 'manual', '記録: stop で集計する');
assert(savedDb.sessions.length === 0, '記録: stop 時点では保存しない（save まで未保存）');
assert(pending.samples[0].satellites.length === 1, '記録: サンプルに衛星リストを残す（後からSkyPlot/SNR再現用）');

const entry = await rec.save(pending, { label: 'テスト地点', memo: 'メモ' });
assert(savedDb.sessions.length === 1 && entry.session.type === 'record', '記録: save で sessions へ保存');
assert(savedDb.points[0].kind === 'record' && savedDb.points[0].samples.length === 10, '記録: save で生エポックを保存');
assert(entry.session.summary.count === 10 && entry.session.summary.drms >= 0, '記録: summary に集計値を残す');
assert(entry.session.label === 'テスト地点' && entry.session.memo === 'メモ', '記録: 地点名・メモは save 時に付与');

console.log(failed ? `\n${failed} 件失敗` : '\n全チェック OK');
process.exit(failed ? 1 : 0);
