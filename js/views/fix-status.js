// 測位ステータス表示：Fix種別・測位モード・使用衛星・DOP・座標・有効測位率。
const QUALITY = {
  0: { t: 'No fix', cls: 'bad' },
  1: { t: 'GPS fix', cls: 'ok' },
  2: { t: 'DGPS', cls: 'ok' },
  4: { t: 'RTK fixed', cls: 'good' },
  5: { t: 'RTK float', cls: 'good' },
  6: { t: 'Dead reckoning', cls: 'warn' },
};
const MODE = { 1: 'No fix', 2: '2D', 3: '3D' };
const fmt = (n) => (n == null ? '—' : n.toFixed(1));

export class FixStatusView {
  constructor(el) {
    this.el = el;
    this.total = 0;
    this.validCount = 0;
    this.el.innerHTML = template();
    this.$ = (s) => this.el.querySelector(s);
  }

  update(epoch) {
    this.total++;
    const q = epoch.quality;
    const valid = q != null && q > 0 && epoch.status !== 'V';
    if (valid) this.validCount++;

    const ql = QUALITY[q] || { t: '—', cls: 'bad' };
    const badge = this.$('.fix-badge');
    badge.textContent = ql.t;
    badge.className = `fix-badge ${ql.cls}`;

    this.$('.v-mode').textContent = MODE[epoch.fixMode] || '—';
    this.$('.v-sats').textContent = epoch.numSV ?? '—';
    this.$('.v-hdop').textContent = fmt(epoch.hdop);
    this.$('.v-pdop').textContent = fmt(epoch.pdop);
    this.$('.v-vdop').textContent = fmt(epoch.vdop);
    this.$('.v-lat').textContent = epoch.lat != null ? epoch.lat.toFixed(6) : '—';
    this.$('.v-lon').textContent = epoch.lon != null ? epoch.lon.toFixed(6) : '—';
    this.$('.v-alt').textContent = epoch.alt != null ? `${epoch.alt.toFixed(1)} m` : '—';
    this.$('.v-time').textContent = epoch.time?.str || '—';
    const rate = this.total ? (100 * this.validCount) / this.total : 0;
    this.$('.v-rate').textContent = `${rate.toFixed(1)} %`;
  }

  reset() {
    this.total = 0;
    this.validCount = 0;
  }
}

function template() {
  return `
    <div class="fix-head">
      <span class="fix-badge bad">—</span>
      <span class="fix-mode-wrap">測位モード <b class="v-mode">—</b></span>
    </div>
    <dl class="fix-grid">
      <div><dt>使用衛星</dt><dd class="v-sats mono">—</dd></div>
      <div><dt>HDOP</dt><dd class="v-hdop mono">—</dd></div>
      <div><dt>PDOP</dt><dd class="v-pdop mono">—</dd></div>
      <div><dt>VDOP</dt><dd class="v-vdop mono">—</dd></div>
      <div><dt>緯度</dt><dd class="v-lat mono">—</dd></div>
      <div><dt>経度</dt><dd class="v-lon mono">—</dd></div>
      <div><dt>標高</dt><dd class="v-alt mono">—</dd></div>
      <div><dt>UTC</dt><dd class="v-time mono">—</dd></div>
      <div><dt>有効測位率</dt><dd class="v-rate mono">—</dd></div>
    </dl>`;
}
