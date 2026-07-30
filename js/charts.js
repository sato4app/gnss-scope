// Canvas 描画3種（スカイプロット / SNRチャート / 散布図）と、その共通土台。
//   CanvasView     : ctx 取得・devicePixelRatio 対応リサイズ・リサイズ時の自動再描画
//   SkyPlotView    : 極座標（半径=仰角・角度=方位・大きさ=SNR・塗り=使用中）
//   SnrChartView   : 衛星別 C/N0 の棒グラフ
//   ScatterPlotView: 記録の中心からの東西×南北オフセット（CEP50 / DRMS 円つき）
// 十字・リング・方位ラベルの描画は下の共通ヘルパに集約している。
// 外に出すのは3つのビューと holdDecision（テスト用）のみ。
import { CONSTELLATION_COLORS } from './nmea.js';

// 衛星データが来ない間、直前フレームを保持する上限 [ms]。超過でクリア（sky/snr 共通）
const HOLD_MS = 8000;

const GRID_COLOR = 'rgba(255,255,255,0.12)';
const LABEL_COLOR = 'rgba(255,255,255,0.45)';
const MONO = (px) => `${px}px ui-monospace, monospace`;

// キャリーフォワード判定（純粋関数）。
// hasSats: 今回のエポックに描画可能な衛星データがあるか
// ageMs:   最後に有効データを受けてからの経過ms（未受信は Infinity）
// 返り値: 'draw'（全描画）| 'hold'（前フレーム保持・何もしない）| 'clear'（クリア）
export function holdDecision(hasSats, ageMs, holdMs) {
  if (hasSats) return 'draw';
  return ageMs <= holdMs ? 'hold' : 'clear';
}

// ---- 共通の描画ヘルパ（スカイプロットと散布図で共用） ----

// 中心から上下左右に half だけ伸びる十字線
function drawCross(ctx, cx, cy, half) {
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy - half);
  ctx.lineTo(cx, cy + half);
  ctx.moveTo(cx - half, cy);
  ctx.lineTo(cx + half, cy);
  ctx.stroke();
}

function strokeCircle(ctx, cx, cy, r, color = GRID_COLOR) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

function fillCircle(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// 方位ラベル（N/S/E/W）を中心から距離 d の位置に描く
function drawCompass(ctx, cx, cy, d, fontPx) {
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = MONO(fontPx);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - d);
  ctx.fillText('S', cx, cy + d);
  ctx.fillText('E', cx + d, cy);
  ctx.fillText('W', cx - d, cy);
}

// ---- 共通土台 ----

// 3種のビュー共通の土台（このファイル内でのみ継承する）
class CanvasView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._last = null; // 直近の描画データ（リサイズ時の再描画用）
    this._lastSatAt = null; // 最後に衛星データを描いた時刻（キャリーフォワード判定用）
    this.w = 0;
    this.h = 0;
    this._resize();
    window.addEventListener('resize', () => {
      this._resize();
      if (this._last != null) this.update(this._last);
    });
  }

  // 論理サイズ {w, h}[CSS px]。既定は要素の client サイズ。正方形ビュー等はオーバーライドする。
  _computeSize() {
    return { w: this.canvas.clientWidth || 0, h: this.canvas.clientHeight || 0 };
  }

  // 実解像度を DPR に合わせ、以後は CSS px 座標系で描ける状態にする
  _resize() {
    const { w, h } = this._computeSize();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  // 表示直後などにサイズが変わっていれば再適用する（描画前に呼ぶ）
  _syncSize() {
    if (!this.canvas.clientWidth) return;
    const { w, h } = this._computeSize();
    if (w !== this.w || h !== this.h) this._resize();
  }

  // 非表示タブから表示に切り替わった直後の再描画（サイズ 0 のまま描いた分を描き直す）
  redraw() {
    this._syncSize();
    if (this._last != null) this.update(this._last);
  }

  // 衛星データの有無から描画/保持/クリアを決める（sky / snr 共通の前処理）。
  // 'draw' のときだけ描画を続行し、'clear' なら枠だけ描き直す。
  _holdOrClear(epoch, hasSats, clearFn) {
    const now = epoch?.recvAt ?? Date.now();
    const age = this._lastSatAt == null ? Infinity : now - this._lastSatAt;
    const decision = holdDecision(hasSats, age, HOLD_MS);
    if (decision === 'hold') return false; // 前フレーム保持（クリアも描画もしない）
    if (decision === 'clear') {
      // 失効：古い衛星を残さないようクリア（枠のみ再描画）
      this._last = null;
      this._lastSatAt = null;
      this._syncSize();
      clearFn();
      return false;
    }
    this._last = epoch; // 最後の有効エポック（リサイズ再描画用）
    this._lastSatAt = now;
    this._syncSize();
    return true;
  }
}

// ---- スカイプロット ----
// 仰角（中心90°→外周0°）と方位角（北を上、時計回り）で衛星を配置。
// 使用中＝塗りつぶし、可視のみ＝中抜き。円の大きさ＝SNR。色＝コンステレーション。
// GSV が欠けた秒はブランクにせず前フレームを保持する（キャリーフォワード）。

export class SkyPlotView extends CanvasView {
  _computeSize() {
    const s = Math.min(this.canvas.clientWidth || 320, this.canvas.clientHeight || 320);
    return { w: s, h: s };
  }

  // クリア＋グリッド（仰角リング 0/30/60° と方位の十字・NSEW ラベル）を描き、幾何を返す
  _drawGrid() {
    const S = this.w;
    const cx = S / 2;
    const cy = S / 2;
    const R = S / 2 - 18;
    this.ctx.clearRect(0, 0, S, S);
    for (const el of [0, 30, 60]) strokeCircle(this.ctx, cx, cy, R * (1 - el / 90));
    drawCross(this.ctx, cx, cy, R);
    drawCompass(this.ctx, cx, cy, R + 9, 11);
    return { cx, cy, R };
  }

  update(epoch) {
    const hasSats = (epoch?.satellites || []).some((s) => s.elev != null && s.azim != null);
    if (!this._holdOrClear(epoch, hasSats, () => this._drawGrid())) return;

    const ctx = this.ctx;
    const { cx, cy, R } = this._drawGrid();
    ctx.textAlign = 'center';
    for (const sat of epoch.satellites) {
      if (sat.elev == null || sat.azim == null) continue;
      const el = Math.max(0, Math.min(90, sat.elev));
      const r = R * (1 - el / 90);
      const a = (sat.azim * Math.PI) / 180; // 0=北(上), 時計回り
      const x = cx + r * Math.sin(a);
      const y = cy - r * Math.cos(a);
      const color = CONSTELLATION_COLORS[sat.sys] || CONSTELLATION_COLORS.unknown;
      const rad = sat.snr != null ? 4 + Math.min(sat.snr, 50) / 10 : 4;

      if (sat.used) {
        fillCircle(ctx, x, y, rad, color);
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = MONO(9);
      ctx.fillText(String(sat.prn), x, y + rad + 7);
    }
  }
}

// ---- SNR（C/N0）チャート ----
// 可視衛星ごとに1本。色＝コンステレーション、使用中＝濃い、可視のみ＝薄い。
// コンステ順→PRN順に並べる。GSV が欠けた秒は前フレームを保持する。

const SYS_ORDER = ['gps', 'glonass', 'galileo', 'beidou', 'qzss', 'mixed', 'unknown'];
const SNR_MAX = 55; // 縦軸の上限 [dBHz]

export class SnrChartView extends CanvasView {
  _computeSize() {
    return { w: this.canvas.clientWidth || 600, h: this.canvas.clientHeight || 200 };
  }

  // クリア＋目盛り（0/20/40 dBHz）を描き、プロット領域のレイアウトを返す
  _drawAxes() {
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    ctx.clearRect(0, 0, W, H);

    const padT = 14;
    const padB = 22;
    const padL = 26;
    const plotH = H - padT - padB;

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = MONO(10);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of [0, 20, 40]) {
      const y = padT + plotH * (1 - v / SNR_MAX);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillText(String(v), padL - 4, y);
    }

    return { padT, padB, padL, plotH };
  }

  update(epoch) {
    const hasSats = (epoch?.satellites || []).some((s) => s.snr != null);
    if (!this._holdOrClear(epoch, hasSats, () => this._drawAxes())) return;

    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    const { padT, padB, padL, plotH } = this._drawAxes();

    const sats = epoch.satellites
      .filter((s) => s.snr != null)
      .sort((a, b) => SYS_ORDER.indexOf(a.sys) - SYS_ORDER.indexOf(b.sys) || a.prn - b.prn);

    const gap = 3;
    const bw = Math.max(4, (W - padL - 6 - gap * (sats.length - 1)) / sats.length);
    ctx.textAlign = 'center';
    sats.forEach((s, i) => {
      const x = padL + 4 + i * (bw + gap);
      const bh = (plotH * Math.min(s.snr, SNR_MAX)) / SNR_MAX;
      const y = padT + plotH - bh;
      ctx.globalAlpha = s.used ? 1 : 0.4;
      ctx.fillStyle = CONSTELLATION_COLORS[s.sys] || CONSTELLATION_COLORS.unknown;
      ctx.fillRect(x, y, bw, bh);
      ctx.globalAlpha = 1;
      if (bw >= 10) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(String(s.prn), x + bw / 2, H - padB + 11);
      }
    });
  }
}

// ---- 散布図 ----
// 記録の中心からの東西(E)×南北(N)オフセット [m]。CEP50 / DRMS の円も重ねる。

export class ScatterPlotView extends CanvasView {
  _computeSize() {
    const s = Math.min(this.canvas.clientWidth || 280, 360);
    return { w: s, h: s };
  }

  clear() {
    this._last = null;
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  // stats: computeStaticStats の戻り値（offsets / cep50 / drms を使用）
  update(stats) {
    this._last = stats;
    this._syncSize();
    const ctx = this.ctx;
    const S = this.w;
    const cx = S / 2;
    const cy = S / 2;
    ctx.clearRect(0, 0, S, S);
    if (!stats || !stats.offsets?.length) return;

    // スケール：最大半径か CEP95 の大きい方が収まるように（最低 1 m）
    const maxR = Math.max(1, stats.cep95 || 0, ...stats.offsets.map((o) => Math.hypot(o.e, o.n)));
    const R = S / 2 - 24;
    const scale = R / maxR;

    drawCross(ctx, cx, cy, S / 2 - 8);

    // 目盛りリング（キリのいい間隔）
    const step = niceStep(maxR);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = MONO(10);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (let r = step; r <= maxR + step / 2; r += step) {
      strokeCircle(ctx, cx, cy, r * scale);
      ctx.fillText(fmtM(r), cx + r * scale * 0.7071 + 2, cy - r * scale * 0.7071 - 2);
    }

    // CEP50（緑）と DRMS（青）の円
    drawStatCircle(ctx, cx, cy, stats.cep50, scale, '#36c98d', 'CEP50');
    drawStatCircle(ctx, cx, cy, stats.drms, scale, '#4f9dff', 'DRMS');

    // 各点と中心
    for (const o of stats.offsets) {
      fillCircle(ctx, cx + o.e * scale, cy - o.n * scale, 2.5, 'rgba(240,169,58,0.75)');
    }
    fillCircle(ctx, cx, cy, 3, '#ffffff');

    drawCompass(ctx, cx, cy, S / 2 - 14, 10);
  }
}

function drawStatCircle(ctx, cx, cy, r, scale, color, label) {
  if (r == null || !(r > 0)) return;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  strokeCircle(ctx, cx, cy, r * scale, color);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = MONO(10);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, cx + r * scale * 0.7071 + 2, cy + r * scale * 0.7071 + 2);
}

// 目盛り間隔を 1/2/5×10^n に丸める
function niceStep(maxR) {
  const raw = maxR / 2;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return m * pow;
}

function fmtM(v) {
  return v >= 10 ? `${Math.round(v)}m` : `${v.toFixed(1)}m`;
}
