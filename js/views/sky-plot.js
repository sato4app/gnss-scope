// スカイプロット：仰角（中心90°→外周0°）と方位角（北を上、時計回り）で衛星を配置。
// 使用中＝塗りつぶし、可視のみ＝中抜き。円の大きさ＝SNR。色＝コンステレーション。
import { CONSTELLATION_COLORS } from '../nmea.js';
import { setupHiDpiCanvas, usedPrnSet } from './view-utils.js';

export class SkyPlotView {
  constructor(canvas) {
    const { ctx, size } = setupHiDpiCanvas(canvas, () => this._last && this.update(this._last), {
      square: true,
      fallbackW: 320,
      fallbackH: 320,
    });
    this.ctx = ctx;
    this._size = size;
  }

  update(epoch) {
    this._last = epoch;
    const ctx = this.ctx;
    const S = this._size.w;
    const cx = S / 2;
    const cy = S / 2;
    const R = S / 2 - 18;
    ctx.clearRect(0, 0, S, S);

    // グリッド（仰角リング 0/30/60° と方位の十字）
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (const el of [0, 30, 60]) {
      const r = R * (1 - el / 90);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - R - 9);
    ctx.fillText('S', cx, cy + R + 9);
    ctx.fillText('E', cx + R + 9, cy);
    ctx.fillText('W', cx - R - 9, cy);

    const used = usedPrnSet(epoch);

    for (const sat of epoch.satsInView || []) {
      if (sat.elev == null || sat.azim == null) continue;
      const el = Math.max(0, Math.min(90, sat.elev));
      const r = R * (1 - el / 90);
      const a = (sat.azim * Math.PI) / 180; // 0=北(上), 時計回り
      const x = cx + r * Math.sin(a);
      const y = cy - r * Math.cos(a);
      const color = CONSTELLATION_COLORS[sat.constellation] || CONSTELLATION_COLORS.unknown;
      const isUsed = used.has(sat.prn);
      const rad = sat.snr != null ? 4 + Math.min(sat.snr, 50) / 10 : 4;

      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      if (isUsed) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(String(sat.prn), x, y + rad + 7);
    }
  }
}
