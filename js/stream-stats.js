// 受信品質統計（docs/algospec-202607.md 5.）。
// 「M10S→Pico→BLE→アプリ」の各段で NMEA を取りこぼしていないかを1回の測定で
// 確認できるよう、パイプラインの通過数・破棄数を集計する。
//   [M10S→Pico]  $PPICO の ng / drop（UART チェックサムNG・バッファ破棄）
//   [Pico→アプリ] Δtxok − Δ受信行数（BLE 通知欠落の推定値）、$PPICO の seq 抜け
//   [アプリ内]    チェックサムNG・未対応センテンス・LineBuffer 溢れ破棄（数えて破棄）
//   [エポック]    時刻ギャップ（欠落エポック）・GSV の部分欠落
// reset() 起点の累計。記録1回分は snapshot() の差分（diffRxStats）で取る。
import { PARSED_TYPES } from './nmea.js';

// 1Hz 前提のエポック時刻ギャップ判定しきい値 [秒]
const EPOCH_GAP_SEC = 1.5;

export class StreamStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.startedAt = Date.now();
    this.lines = 0; // LineBuffer が復元した全行（$PPICO 含む）
    this.csNg = 0; // チェックサム不一致（破棄済み）
    this.parsedOk = 0; // 内容まで解釈した行（GGA/RMC/GSA/GSV/VTG/GST）
    this.unknown = 0; // チェックサムは正常だが未対応の種別（計数のみで無視）
    this.discardedChars = 0; // LineBuffer 溢れで捨てた文字数
    this.epochs = 0; // 確定エポック数
    this.epochGaps = 0; // 時刻ギャップから推定した欠落エポック数
    this.gsvMissing = 0; // GSV グループの部分欠落（届かなかったメッセージ数）
    this.pico = null; // 最新の $PPICO { seq, rx, ng, drop, txok, txng, at }
    this.picoSeqGaps = 0; // $PPICO 自体の欠落数（seq 抜け）
    this._picoBase = null; // BLE 欠落推定の基準点 { txok, lines }
    this._prevSod = null; // 直前エポックの時刻（秒/日内）
  }

  // LineBuffer から出た1行（パース済み）ごとに呼ぶ。
  // $PPICO は統計にのみ反映し true を返す（エポック組み立てへ回さない）。
  addLine(parsed) {
    this.lines++;
    if (parsed.type === 'PPICO') {
      if (parsed.valid) this._addPico(parsed);
      else this.csNg++;
      return true;
    }
    if (!parsed.valid) this.csNg++;
    else if (PARSED_TYPES.has(parsed.type)) this.parsedOk++;
    else this.unknown++;
    return false;
  }

  _addPico(p) {
    const prev = this.pico;
    if (prev && (p.seq < prev.seq || p.txok < prev.txok)) {
      this._picoBase = null; // カウンタ後退 = Pico 再起動 → 基準を取り直す
    } else if (prev && p.seq > prev.seq + 1) {
      this.picoSeqGaps += p.seq - prev.seq - 1;
    }
    this.pico = { seq: p.seq, rx: p.rx, ng: p.ng, drop: p.drop, txok: p.txok, txng: p.txng, at: Date.now() };
    // 基準点：最初の $PPICO 受信時点の txok とアプリ受信行数（この行自身を含む）を対応付ける。
    // 以降は Δtxok（$PPICO 含む送信数）と Δlines（$PPICO 含む受信数）が一致するはず。
    if (!this._picoBase) this._picoBase = { txok: p.txok, lines: this.lines };
  }

  // 確定エポックごとに呼ぶ（epoch.js の onEpoch から）
  addEpoch(epoch) {
    this.epochs++;
    if (epoch.gsvMissing) this.gsvMissing += epoch.gsvMissing;
    const t = epoch.time;
    if (!t) return; // 時刻なし（アイドル確定の端数エポック等）はギャップ判定に使わない
    const sod = t.h * 3600 + t.m * 60 + t.s;
    if (this._prevSod != null) {
      let dt = sod - this._prevSod;
      if (dt < -43200) dt += 86400; // UTC 日跨ぎ
      if (dt > EPOCH_GAP_SEC) this.epochGaps += Math.round(dt) - 1;
    }
    this._prevSod = sod;
  }

  // LineBuffer の溢れ破棄通知
  noteDiscard(chars) {
    this.discardedChars += chars;
  }

  // BLE 経路の欠落行数の推定（Pico が送った数 − アプリが行として数えた数）。
  // 化けて届いた行は「受信した行」として数えられるため、これは通知ごと消えた分の推定。
  // $PPICO 未受信（基準なし）は null。
  get bleLossEst() {
    if (!this.pico || !this._picoBase) return null;
    return Math.max(0, this.pico.txok - this._picoBase.txok - (this.lines - this._picoBase.lines));
  }

  // 現在値の複製（測定区間の差分計算・保存用）
  snapshot() {
    return {
      lines: this.lines,
      csNg: this.csNg,
      parsedOk: this.parsedOk,
      unknown: this.unknown,
      discardedChars: this.discardedChars,
      epochs: this.epochs,
      epochGaps: this.epochGaps,
      gsvMissing: this.gsvMissing,
      picoSeqGaps: this.picoSeqGaps,
      bleLossEst: this.bleLossEst,
      pico: this.pico ? { ...this.pico } : null,
    };
  }
}

// 測定区間（start → end の snapshot）の差分。記録1回分の品質を summary に載せる用。
// Pico カウンタは累計のため、区間開始時に $PPICO 未受信なら帰属できず null（不明）とする。
export function diffRxStats(end, start) {
  const d = (k) => end[k] - (start ? start[k] : 0);
  const samePico =
    end.pico && start?.pico && end.pico.seq >= start.pico.seq && end.pico.txok >= start.pico.txok;
  return {
    lines: d('lines'),
    csNg: d('csNg'),
    parsedOk: d('parsedOk'),
    unknown: d('unknown'),
    discardedChars: d('discardedChars'),
    epochs: d('epochs'),
    epochGaps: d('epochGaps'),
    gsvMissing: d('gsvMissing'),
    picoSeqGaps: d('picoSeqGaps'),
    bleLossEst: end.bleLossEst == null ? null : Math.max(0, end.bleLossEst - (start?.bleLossEst ?? 0)),
    pico: samePico
      ? {
          rx: end.pico.rx - start.pico.rx,
          ng: end.pico.ng - start.pico.ng,
          drop: end.pico.drop - start.pico.drop,
          txng: end.pico.txng - start.pico.txng,
        }
      : null,
  };
}
