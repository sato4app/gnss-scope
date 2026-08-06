// Canvas 描画3種（スカイプロット / SNRチャート / 散布図）と、その共通土台。
//   CanvasView     : ctx 取得・devicePixelRatio 対応リサイズ・リサイズ時の自動再描画
//   SkyPlotView    : 極座標（半径=仰角・角度=方位・大きさ=SNR・塗り=使用中）
//   SnrChartView   : 衛星別 C/N0 の棒グラフ
//   ScatterPlotView: 記録の中心からの東西×南北オフセット（CEP50 / DRMS 円つき）
// 十字・リング・方位ラベルの描画は下の共通ヘルパに集約している。
// 外に出すのは3つのビューと holdDecision（テスト用）のみ。
import { CONSTELLATION_COLORS } from './nmea.js';
import { SERIES } from './constants.js';

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

function strokeCircle(ctx, cx, cy, r, color = GRID_COLOR, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
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

// 正方形ビュー（スカイプロット / 散布図）の論理サイズ：CSS ボックスの短辺に合わせる
function squareSize(canvas, fallback) {
  const s = Math.min(canvas.clientWidth || fallback, canvas.clientHeight || fallback);
  return { w: s, h: s };
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
// 2列レイアウトでは表示が小さくなるため、記号を縮小し PRN ラベルは省く。

const SKY_BASE = 320; // 記号サイズの基準幅 [CSS px]
const SKY_PRN_MIN = 240; // PRN ラベルを描く最小幅（これ未満は重なって読めない）

export class SkyPlotView extends CanvasView {
  _computeSize() {
    return squareSize(this.canvas, 320);
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
    const k = Math.max(0.55, Math.min(1, this.w / SKY_BASE)); // 表示幅に応じた記号の縮小率
    const showPrn = this.w >= SKY_PRN_MIN;
    ctx.textAlign = 'center';
    for (const sat of epoch.satellites) {
      if (sat.elev == null || sat.azim == null) continue;
      const el = Math.max(0, Math.min(90, sat.elev));
      const r = R * (1 - el / 90);
      const a = (sat.azim * Math.PI) / 180; // 0=北(上), 時計回り
      const x = cx + r * Math.sin(a);
      const y = cy - r * Math.cos(a);
      const color = CONSTELLATION_COLORS[sat.sys] || CONSTELLATION_COLORS.unknown;
      const rad = (sat.snr != null ? 4 + Math.min(sat.snr, 50) / 10 : 4) * k;

      // 使用中＝塗りつぶし / 可視のみ＝中抜き
      if (sat.used) fillCircle(ctx, x, y, rad, color);
      else strokeCircle(ctx, x, y, rad, color, 1.5);

      if (showPrn) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = MONO(9);
        ctx.fillText(String(sat.prn), x, y + rad + 7);
      }
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
//
// 表示半径（仕様 5）:
//   R = max(2m, GNSS受信機DRMS×4, Android内蔵DRMS×2) を 1/2/5×10^n に切り上げる。
//   両系統の「最大半径」で決めると、内蔵の外れ点1つで受信機の点群が中心の数ピクセルへ
//   潰れてしまうため、外れ値に強い DRMS を基準にする。
//   記録開始直後は DRMS≒0 なので下限 2m を置き、さらにヒステリシス（目標が現在の
//   半分を下回るまで縮小しない）で毎秒スケールが動くのを防ぐ。
//   R の外に出た点は縁に▲でクランプし、系統別の件数を outside に残す
//   （「外側にn点」を出しつつ、どちらへ飛んだかの方向も捨てない）。
// 内蔵の点は中抜きで描く。色だけに頼ると直射日光下・色覚特性で区別が付かないため。

const SCATTER_MIN_RADIUS_M = 2; // 表示半径の下限 [m]
const GNSS_DRMS_FACTOR = 4; // GNSS受信機 DRMS の何倍まで入れるか
const DEVICE_DRMS_FACTOR = 2; // Android内蔵 DRMS の何倍まで入れるか

export class ScatterPlotView extends CanvasView {
  _computeSize() {
    return squareSize(this.canvas, 280);
  }

  clear() {
    this._last = null;
    this._lastDevice = null;
    this.outside = { gnss: 0, device: 0 };
    this.resetScale();
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  // 表示半径のヒステリシスを解除する。別の記録へ切り替えるときに呼ぶ
  // （前の記録のスケールを引きずらないため）。
  resetScale() {
    this._radiusM = null;
  }

  // stats:       computeStaticStats の戻り値（offsets / cep50 / drms を使用）
  // deviceStats: Android内蔵GNSS の比較系列（computeDeviceStats）。null で比較なし。
  //   既定値を保持中の系列にしているのは、基底クラスのリサイズ再描画が
  //   update(this._last) と1引数で呼ぶため（明示的に null を渡せば消える）。
  // 戻り値: 表示範囲の外に出た点数 { gnss, device }（凡例の「外側にn点」用）
  update(stats, deviceStats = this._lastDevice) {
    this._last = stats;
    this._lastDevice = deviceStats || null;
    this.outside = { gnss: 0, device: 0 };
    this._syncSize();
    const ctx = this.ctx;
    const S = this.w;
    const cx = S / 2;
    const cy = S / 2;
    ctx.clearRect(0, 0, S, S);
    if (!stats || !stats.offsets?.length) return this.outside;

    // 比較系列は GNSS受信機の中心を共通原点にして重ねる（ばらつきに加えて中心のズレも見える）
    const dev = this._lastDevice?.offsets?.length ? this._lastDevice : null;
    const dE = dev?.offsetFromRef?.e || 0;
    const dN = dev?.offsetFromRef?.n || 0;
    const devPts = dev ? dev.offsets.map((o) => ({ e: o.e + dE, n: o.n + dN })) : [];

    const maxR = this._radiusFor(stats, dev);
    // 内蔵の中心そのものが枠外なら、中心マーカーと DRMS 円は描かない（点は▲で縁に出る）
    const devCenterInside = dev && Math.hypot(dE, dN) <= maxR;
    const R = S / 2 - 24;
    const scale = R / maxR;

    drawCross(ctx, cx, cy, S / 2 - 8);

    // 目盛りリング（キリのいい間隔）。表示半径 maxR より外には描かない
    // （maxR は範囲外の点をクランプする境界なので、その外にリングがあると誤解を招く）
    const step = niceStep(maxR);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = MONO(10);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (let r = step; r <= maxR + 1e-9; r += step) {
      strokeCircle(ctx, cx, cy, r * scale);
      ctx.fillText(fmtM(r), cx + r * scale * 0.7071 + 2, cy - r * scale * 0.7071 - 2);
    }

    // 比較系列（背面に描いて GNSS受信機を前に出す）
    if (dev) {
      this.outside.device = this._drawPoints(devPts, cx, cy, scale, maxR, SERIES.device, false);
      if (devCenterInside) {
        // 目盛りラベル（右上）と GNSS受信機の円（左下 / 右下）を避けて左上に置く
        const label = 'DRMS'; // ラベルは種別、色が系統を表す
        drawStatCircle(ctx, cx + dE * scale, cy - dN * scale, dev.drms, scale, SERIES.device.color, label, { x: -1, y: -1 });
      }
    }

    // CEP50（緑）と DRMS（青）の円
    drawStatCircle(ctx, cx, cy, stats.cep50, scale, '#36c98d', 'CEP50', { x: -1, y: 1 });
    drawStatCircle(ctx, cx, cy, stats.drms, scale, '#4f9dff', 'DRMS', { x: 1, y: 1 });

    // 各点と中心
    this.outside.gnss = this._drawPoints(stats.offsets, cx, cy, scale, maxR, SERIES.gnss, true);
    if (devCenterInside) fillCircle(ctx, cx + dE * scale, cy - dN * scale, 3, SERIES.device.color);
    fillCircle(ctx, cx, cy, 3, '#ffffff');

    drawCompass(ctx, cx, cy, S / 2 - 14, 10);
    return this.outside;
  }

  // 表示半径 [m]。ヒステリシス付き（記録中に毎秒スケールが動くのを防ぐ）。
  _radiusFor(stats, dev) {
    const target = Math.max(
      SCATTER_MIN_RADIUS_M,
      (stats?.drms || 0) * GNSS_DRMS_FACTOR,
      (dev?.drms || 0) * DEVICE_DRMS_FACTOR
    );
    // 拡大は即座に、縮小は目標が現在の半分を下回るまで待つ
    if (this._radiusM == null || target > this._radiusM || target < this._radiusM / 2) {
      this._radiusM = niceCeil(target);
    }
    return this._radiusM;
  }

  // 1系統ぶんの点を描く。範囲外は縁に▲でクランプし、その件数を返す。
  // filled=false（Android内蔵）は中抜き。塗りより見えにくいぶん半径を大きくする。
  _drawPoints(points, cx, cy, scale, maxR, series, filled) {
    const ctx = this.ctx;
    let outside = 0;
    for (const o of points) {
      if (Math.hypot(o.e, o.n) > maxR) {
        outside++;
        drawOutMarker(ctx, cx, cy, Math.atan2(o.e, o.n), maxR * scale, series.color);
        continue;
      }
      const x = cx + o.e * scale;
      const y = cy - o.n * scale;
      if (filled) fillCircle(ctx, x, y, 2.5, series.point);
      else strokeCircle(ctx, x, y, 3.5, series.point, 1.2);
    }
    return outside;
  }
}

// 表示範囲の外に出た点。縁に寄せて外向きの▲で描く（件数だけでなく方向も残す）。
// angleRad は 0=北・時計回り（散布図の方位と同じ向き）。
function drawOutMarker(ctx, cx, cy, angleRad, rPix, color) {
  const size = 4;
  ctx.save();
  ctx.translate(cx + rPix * Math.sin(angleRad), cy - rPix * Math.cos(angleRad));
  ctx.rotate(angleRad); // 回転前の上向き（-y）が外向きになる
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.8, size * 0.7);
  ctx.lineTo(-size * 0.8, size * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// 統計円（破線）＋ラベル。dir はラベルを置く象限の単位ベクトル（canvas 座標なので y>0 が下）。
// 比較系列を重ねると受信機側の円が相対的に小さくなり、同じ向きだとラベルが中心で潰れるため、
// 系列ごとに向きを変え、かつ中心から最低 10 px は離す。
function drawStatCircle(ctx, cx, cy, r, scale, color, label, dir = { x: 1, y: 1 }) {
  if (r == null || !(r > 0)) return;
  ctx.setLineDash([4, 3]);
  strokeCircle(ctx, cx, cy, r * scale, color);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = MONO(10);
  ctx.textAlign = dir.x > 0 ? 'left' : 'right';
  ctx.textBaseline = dir.y > 0 ? 'top' : 'bottom';
  const d = Math.max(r * scale * 0.7071, 10) + 2;
  ctx.fillText(label, cx + dir.x * d, cy + dir.y * d);
}

// 表示半径の段階。目盛りの 1/2/5 より細かく刻む。
// 粗いと DRMS が少し増えただけで半径が倍になり（例 4×1.27=5.08m → 10m）、
// 点群が中心の小さな塊に見えてしまう。この刻みなら行き過ぎは最大 1.5 倍に収まる。
const RADIUS_STEPS = [1, 1.5, 2, 3, 4, 5, 6, 8];

// 表示半径を RADIUS_STEPS×10^n の段階へ切り上げる（段階を刻むことでスケールのばたつきを抑える）
function niceCeil(v) {
  if (!(v > 0)) return SCATTER_MIN_RADIUS_M;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const m = RADIUS_STEPS.find((s) => n <= s * (1 + 1e-9)) ?? 10;
  return m * pow;
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
