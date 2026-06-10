// データ品質レポート（FR-10）：
//   - チェックサム通過率（valid / (valid+invalid)）
//   - センテンス種別ごとの累計と更新レート[Hz]
//   - エポック間隔のジッタ（平均・σ）とヒストグラム
//   - 欠損率（測位の核である GGA を欠いたエポックの割合）
// 入力は既存土台の Epoch（js/epoch.js）。sentenceTypes / invalidCount を活用する。
//
// 受け入れ基準：1Hz 設定時に実測間隔のばらつきを可視化（ヒストグラム）。

const TYPES = ['GGA', 'RMC', 'GSA', 'GSV'];

// エポック間隔ヒストグラムのビン（ms）。1Hz=1000ms を中心に裾を見る。
const BIN_EDGES = [0, 500, 700, 800, 900, 950, 1000, 1050, 1100, 1200, 1300, 1500, 2000, Infinity];

export class DataQualityView {
  constructor(el) {
    this.el = el;
    this.el.innerHTML = template();
    this.$ = (s) => this.el.querySelector(s);
    this.canvas = this.$('.dq-hist');
    this.ctx = this.canvas.getContext('2d');
    this._resize();
    window.addEventListener('resize', () => {
      this._resize();
      this._drawHist();
    });
    this.reset();
  }

  reset() {
    this.validSentences = 0;
    this.invalidSentences = 0;
    this.typeCounts = Object.fromEntries(TYPES.map((t) => [t, 0]));
    this.epochCount = 0;
    this.missingGga = 0;
    this.firstRecvAt = null;
    this.lastRecvAt = null;
    this.intervals = []; // エポック間の実測間隔[ms]（直近 maxSamples 件）
    this.maxSamples = 600;
    this.bins = new Array(BIN_EDGES.length - 1).fill(0);
    this._render();
  }

  update(epoch) {
    this.epochCount++;

    // チェックサム：エポックの sentenceTypes 合計が valid 数、invalidCount が不正数
    for (const [type, n] of Object.entries(epoch.sentenceTypes || {})) {
      this.validSentences += n;
      if (this.typeCounts[type] != null) this.typeCounts[type] += n;
    }
    this.invalidSentences += epoch.invalidCount || 0;

    // 欠損率：GGA を欠いた（quality も座標も来ていない）エポック
    if (!(epoch.sentenceTypes && epoch.sentenceTypes.GGA)) this.missingGga++;

    // エポック間隔（実測）
    const now = epoch.recvAt || Date.now();
    if (this.lastRecvAt != null) {
      const dt = now - this.lastRecvAt;
      this.intervals.push(dt);
      if (this.intervals.length > this.maxSamples) this.intervals.shift();
      this._binInterval(dt);
    }
    if (this.firstRecvAt == null) this.firstRecvAt = now;
    this.lastRecvAt = now;

    this._render();
  }

  _binInterval(dt) {
    for (let i = 0; i < this.bins.length; i++) {
      if (dt >= BIN_EDGES[i] && dt < BIN_EDGES[i + 1]) {
        this.bins[i]++;
        return;
      }
    }
  }

  _stats() {
    const arr = this.intervals;
    if (!arr.length) return { mean: null, sd: null };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return { mean, sd: Math.sqrt(variance) };
  }

  _render() {
    const total = this.validSentences + this.invalidSentences;
    const pass = total ? (100 * this.validSentences) / total : null;
    this.$('.v-checksum').textContent = pass == null ? '—' : `${pass.toFixed(2)} %`;
    this.$('.v-invalid').textContent = String(this.invalidSentences);
    this.$('.v-epochs').textContent = String(this.epochCount);

    const { mean, sd } = this._stats();
    this.$('.v-interval').textContent = mean == null ? '—' : `${mean.toFixed(0)} ms`;
    this.$('.v-jitter').textContent = sd == null ? '—' : `±${sd.toFixed(0)} ms`;

    const miss = this.epochCount ? (100 * this.missingGga) / this.epochCount : null;
    this.$('.v-missing').textContent = miss == null ? '—' : `${miss.toFixed(1)} %`;

    // 更新レート：受信開始からの経過で種別ごとの Hz を出す
    const elapsedSec = this.firstRecvAt && this.lastRecvAt ? (this.lastRecvAt - this.firstRecvAt) / 1000 : 0;
    const rates = this.$('.dq-rates');
    rates.innerHTML = TYPES.map((t) => {
      const c = this.typeCounts[t];
      const hz = elapsedSec > 0 ? c / elapsedSec : 0;
      return `<div><dt>${t}</dt><dd class="mono">${c} <span class="dq-hz">(${hz.toFixed(2)} Hz)</span></dd></div>`;
    }).join('');

    this._drawHist();
  }

  _resize() {
    const w = this.canvas.clientWidth || 400;
    const h = this.canvas.clientHeight || 120;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cw = w;
    this.ch = h;
  }

  // エポック間隔の分布をシンプルな棒で描く
  _drawHist() {
    const ctx = this.ctx;
    const W = this.cw;
    const H = this.ch;
    ctx.clearRect(0, 0, W, H);

    const padB = 16;
    const padT = 6;
    const plotH = H - padB - padT;
    const n = this.bins.length;
    const max = Math.max(1, ...this.bins);
    const gap = 2;
    const bw = (W - gap * (n - 1)) / n;

    ctx.font = '9px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';

    for (let i = 0; i < n; i++) {
      const x = i * (bw + gap);
      const bh = plotH * (this.bins[i] / max);
      const y = padT + plotH - bh;
      // 1000ms 近傍（理想）を強調、外れ値は警告色
      const lo = BIN_EDGES[i];
      const ideal = lo >= 900 && lo < 1100;
      ctx.fillStyle = ideal ? '#3ad0c4' : 'rgba(90,169,255,0.55)';
      ctx.fillRect(x, y, bw, bh);
      // ビン下限ラベル（間引き）
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        const label = lo === 0 ? '0' : lo >= 2000 ? '2k+' : String(lo);
        ctx.fillText(label, x + bw / 2, padT + plotH + 3);
      }
    }
  }
}

function template() {
  return `
    <dl class="fix-grid dq-grid">
      <div><dt>チェックサム通過率</dt><dd class="v-checksum mono">—</dd></div>
      <div><dt>不正センテンス</dt><dd class="v-invalid mono">—</dd></div>
      <div><dt>エポック数</dt><dd class="v-epochs mono">—</dd></div>
      <div><dt>GGA欠損率</dt><dd class="v-missing mono">—</dd></div>
      <div><dt>平均エポック間隔</dt><dd class="v-interval mono">—</dd></div>
      <div><dt>ジッタ(σ)</dt><dd class="v-jitter mono">—</dd></div>
    </dl>
    <h3 class="dq-sub">センテンス更新レート</h3>
    <dl class="fix-grid dq-rates"></dl>
    <h3 class="dq-sub">エポック間隔の分布（ms）</h3>
    <canvas class="dq-hist"></canvas>`;
}
