// 時系列グラフ（FR-7）：エポックを直近 N 秒のリングバッファに蓄積し、
// 使用衛星数・HDOP・平均SNR を時間軸で表示する。
// 描画は uPlot（CDN, グローバル window.uPlot）。1Hz・長時間でも軽い再描画を狙う（NFR-3）。
//
// 既存土台（js/epoch.js の Epoch）はそのまま入力に使う。再実装しない。

const COLORS = {
  sv: '#5aa9ff', // 使用衛星数
  hdop: '#f0a93a', // HDOP
  snr: '#3ad0c4', // 平均SNR
};

// エポックから平均SNRを出す：使用衛星があれば使用衛星、無ければ可視衛星で平均。
function avgSnr(epoch) {
  const used = new Set((epoch.usedSVs || []).map((u) => u.prn));
  const inView = (epoch.satsInView || []).filter((s) => s.snr != null);
  const usedSnr = inView.filter((s) => used.has(s.prn)).map((s) => s.snr);
  const pool = usedSnr.length ? usedSnr : inView.map((s) => s.snr);
  if (!pool.length) return null;
  return pool.reduce((a, b) => a + b, 0) / pool.length;
}

export class TimeSeriesView {
  // windowSec: 表示・保持する直近の秒数
  constructor(el, { windowSec = 300 } = {}) {
    this.el = el;
    this.windowSec = windowSec;
    // uPlot のデータ列：[ x(秒), 使用衛星数, HDOP, 平均SNR ]
    this.data = [[], [], [], []];
    this.plot = null;
    this._initPlot();
    window.addEventListener('resize', () => this._resize());
  }

  _size() {
    return {
      width: this.el.clientWidth || 600,
      height: this.el.clientHeight || 220,
    };
  }

  _initPlot() {
    if (typeof window.uPlot === 'undefined') {
      // uPlot 未読込時は静かにフォールバック（後続の update でも描画しない）
      this.el.innerHTML = '<p class="hint">uPlot を読み込めませんでした（オフライン時はキャッシュ要確認）。</p>';
      return;
    }
    const { width, height } = this._size();
    const opts = {
      width,
      height,
      // 横軸は経過秒。UTC等への変換はせず受信時刻ベースの相対秒で見せる。
      scales: {
        x: { time: false },
        sv: { range: [0, 40] },
        dop: { range: [0, 6] },
        snr: { range: [0, 55] },
      },
      axes: [
        { stroke: 'rgba(231,236,243,0.5)', grid: { stroke: 'rgba(255,255,255,0.06)' }, ticks: { stroke: 'rgba(255,255,255,0.1)' } },
        // 左軸：平均SNR[dBHz]
        { scale: 'snr', stroke: COLORS.snr, grid: { stroke: 'rgba(255,255,255,0.06)' }, ticks: { stroke: 'rgba(255,255,255,0.1)' }, size: 42 },
        // 右軸：使用衛星数
        { scale: 'sv', side: 1, stroke: COLORS.sv, grid: { show: false }, ticks: { stroke: 'rgba(255,255,255,0.1)' }, size: 38 },
      ],
      series: [
        {},
        { label: '使用衛星', scale: 'sv', stroke: COLORS.sv, width: 1.5, points: { show: false } },
        { label: 'HDOP', scale: 'dop', stroke: COLORS.hdop, width: 1.5, dash: [4, 3], points: { show: false } },
        { label: '平均SNR', scale: 'snr', stroke: COLORS.snr, width: 1.5, points: { show: false } },
      ],
      legend: { live: true },
      cursor: { drag: { x: true, y: false }, points: { size: 6 } },
    };
    this.plot = new window.uPlot(opts, this.data, this.el);
  }

  _resize() {
    if (!this.plot) return;
    const { width, height } = this._size();
    this.plot.setSize({ width, height });
  }

  update(epoch) {
    if (!this.plot) return;
    // x はエポックの受信時刻（秒）。最初のエポックを起点に相対秒へ。
    const t = (epoch.recvAt || Date.now()) / 1000;
    if (this._t0 == null) this._t0 = t;
    const x = t - this._t0;

    this.data[0].push(x);
    this.data[1].push(epoch.numSV ?? null);
    this.data[2].push(epoch.hdop ?? null);
    this.data[3].push(avgSnr(epoch));

    // リングバッファ：windowSec を超えた古い点を捨てる
    const minX = x - this.windowSec;
    let drop = 0;
    while (drop < this.data[0].length && this.data[0][drop] < minX) drop++;
    if (drop > 0) for (const col of this.data) col.splice(0, drop);

    this.plot.setData(this.data);
  }

  reset() {
    this._t0 = null;
    this.data = [[], [], [], []];
    if (this.plot) this.plot.setData(this.data);
  }
}
