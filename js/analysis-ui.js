// 解析タブの配線：SkyPlot / SNR / DOP / DRMS の4本立て。
// データソースは「ライブ（受信中の最新エポック）」と「読込データ（load した記録）」を
// ラジオで切り替える。読込データはスライダで任意のエポックを選んで再現できる
// （記録時に衛星リストも保存しているため、後からでもスカイプロット/SNR を描ける）。
import { $, fmt, FIX_MODE, satsText, formatStats, formatCompare, sessionMeta } from './view-utils.js';
import { CONSTELLATION_COLORS, CONSTELLATION_LABELS } from './nmea.js';
import { SkyPlotView, SnrChartView, ScatterPlotView } from './charts.js';
import { estimateHorizontalAccuracy } from './accuracy.js';

const DOP_KEYS = ['pdop', 'hdop', 'vdop'];

// 衛星リストから系統別の数を数える（読込データ用のフォールバック）
function countBySys(satellites, onlyUsed) {
  const out = {};
  for (const s of satellites || []) {
    if (onlyUsed && !s.used) continue;
    out[s.sys] = (out[s.sys] || 0) + 1;
  }
  return out;
}

// 保存サンプル → 表示用エポック（charts.js が期待する形に揃える）
function sampleToEpoch(sample) {
  return {
    ...sample,
    recvAt: Date.now(), // キャリーフォワード判定用
    satellites: sample.satellites || [],
    usedBySys: countBySys(sample.satellites, true),
    inViewBySys: countBySys(sample.satellites, false),
  };
}

export function initAnalysisUI({ settings, getLatestEpoch }) {
  const skyView = new SkyPlotView($('sky-plot'));
  const snrView = new SnrChartView($('snr-chart'));
  const scatterView = new ScatterPlotView($('an-scatter'));

  let source = 'live';
  let loaded = null; // { session, point }
  let liveStats = null; // 記録中/直近の記録の集計（ライブ表示時の DRMS）
  let liveDeviceStats = null; // 同区間の端末内蔵GNSS の集計（比較用。無ければ null）
  let index = 0; // 読込データのエポック位置

  // 凡例（コンステレーション色）
  $('legend').innerHTML = Object.entries(CONSTELLATION_LABELS)
    .filter(([id]) => id !== 'unknown' && id !== 'mixed')
    .map(([id, label]) => `<span><i class="swatch" style="background:${CONSTELLATION_COLORS[id]}"></i>${label}</span>`)
    .join('');

  const samples = () => loaded?.point?.samples || [];

  // 1エポック分（ライブ / 読込 共通）の描画
  function renderEpoch(epoch) {
    skyView.update(epoch);
    snrView.update(epoch);

    for (const k of DOP_KEYS) {
      $(`an-${k}`).textContent = fmt(epoch[k]);
      const bar = $(`bar-${k}`);
      const v = epoch[k];
      bar.style.width = v == null ? '0' : `${Math.min(v / 6, 1) * 100}%`; // 6以上で満タン扱い
      if (v != null) bar.style.background = v < 2 ? 'var(--good)' : v < 4 ? 'var(--warn)' : 'var(--bad)';
    }
    $('an-mode').textContent = FIX_MODE[epoch.fixMode] || '—';
    $('an-sats').textContent = satsText(epoch);
    const acc = estimateHorizontalAccuracy(epoch, settings.uere);
    $('an-accsrc').textContent = acc ? `${acc.source}　±${acc.value.toFixed(1)} m` : '—';
    $('an-gst').textContent =
      epoch.latStd != null ? `${epoch.latStd.toFixed(2)} / ${epoch.lonStd.toFixed(2)} m` : '出力なし';

    // 系統別内訳チップ（ライブは GSA 由来の内訳、読込データは衛星リストから算出）
    const usedBySys = epoch.usedBySys || countBySys(epoch.satellites, true);
    const inViewBySys = epoch.inViewBySys || countBySys(epoch.satellites, false);
    const sysIds = new Set([...Object.keys(usedBySys), ...Object.keys(inViewBySys)]);
    $('an-sys').innerHTML = sysIds.size
      ? [...sysIds]
          .map((sys) => {
            const color = CONSTELLATION_COLORS[sys] || CONSTELLATION_COLORS.unknown;
            const label = CONSTELLATION_LABELS[sys] || sys;
            return `<span class="sys-chip"><i class="swatch" style="background:${color}"></i>${label} ${usedBySys[sys] || 0}/${inViewBySys[sys] ?? '—'}</span>`;
          })
          .join('')
      : '—';
  }

  function clearEpochUi() {
    // 衛星データなしとして扱わせ、グリッド/目盛りだけを描いた状態に戻す（charts.js）
    skyView.update(null);
    snrView.update(null);
    for (const k of DOP_KEYS) {
      $(`an-${k}`).textContent = '—';
      $(`bar-${k}`).style.width = '0';
    }
    for (const id of ['an-mode', 'an-sats', 'an-accsrc', 'an-gst', 'an-sys']) $(id).textContent = '—';
  }

  // DRMS（散布図＋集計テキスト）。同区間の端末内蔵GNSS があれば重ねて比較する（仕様 5-4）。
  function renderDrms() {
    const st = source === 'loaded' ? loaded?.point?.stats : liveStats;
    const dst = source === 'loaded' ? loaded?.point?.deviceStats || null : liveDeviceStats;
    // 比較データがある記録のときだけトグルを出す
    $('an-cmp-row').hidden = !(st && dst);
    const cmp = st && dst && $('an-cmp').checked ? dst : null;
    $('an-scatter-legend').hidden = !cmp;

    scatterView.update(st, cmp);
    if (st) {
      const meta = source === 'loaded' ? sessionMeta(loaded.session) : { label: '記録中/直近の記録' };
      const compareText = cmp ? `\n${formatCompare(st, cmp)}` : '';
      $('an-drms').textContent = formatStats(meta, st) + compareText;
    } else {
      $('an-drms').textContent =
        source === 'loaded'
          ? '読込データに集計値がありません'
          : '記録（record）を開始するか、保存済みの記録を読み込むと表示されます';
    }
  }

  // 読込データのエポック位置表示
  function renderEpochBox() {
    const list = samples();
    const box = $('an-epoch-box');
    box.hidden = source !== 'loaded' || list.length === 0;
    if (box.hidden) return;
    $('an-epoch').max = String(list.length - 1);
    $('an-epoch').value = String(index);
    const t = list[index]?.t;
    const time = t ? new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'UTC' }) : '—';
    $('an-epoch-label').textContent = `エポック ${index + 1} / ${list.length}　${time} UTC`;
  }

  function refresh() {
    $('an-src-note').textContent =
      source === 'loaded'
        ? loaded
          ? `${loaded.session.label}（${samples().length} エポック）`
          : '読込データがありません'
        : '受信中の最新エポック';

    renderEpochBox();
    const epoch = source === 'loaded' ? samples()[index] && sampleToEpoch(samples()[index]) : getLatestEpoch();
    if (epoch) renderEpoch(epoch);
    else clearEpochUi();
    renderDrms();
  }

  for (const radio of document.querySelectorAll('input[name="ansrc"]')) {
    radio.addEventListener('change', (e) => {
      source = e.target.value;
      refresh();
    });
  }

  $('an-cmp').addEventListener('change', renderDrms);

  $('an-epoch').addEventListener('input', (e) => {
    index = Math.max(0, +e.target.value || 0);
    renderEpochBox();
    const s = samples()[index];
    if (s) renderEpoch(sampleToEpoch(s));
  });

  // ---- 外部からの更新 ----

  // ライブの1エポック（app.js の render から。ライブ表示中のみ描く）
  function renderLive(epoch) {
    if (source === 'live') renderEpoch(epoch);
  }

  // 記録中/停止直後の集計（ライブ表示の DRMS 用）。deviceStats は比較系列（無ければ null）。
  function setLiveStats(stats, deviceStats = null) {
    liveStats = stats;
    liveDeviceStats = deviceStats;
    if (source === 'live') renderDrms();
  }

  // 読込データの差し替え。読み込んだら解析対象も自動で読込データへ切り替える。
  function setLoaded(entry) {
    loaded = entry;
    index = 0;
    const loadedRadio = document.querySelector('input[name="ansrc"][value="loaded"]');
    loadedRadio.disabled = !entry;
    if (entry) {
      loadedRadio.checked = true;
      source = 'loaded';
    } else if (source === 'loaded') {
      document.querySelector('input[name="ansrc"][value="live"]').checked = true;
      source = 'live';
    }
    refresh();
  }

  setLoaded(null);

  return { renderLive, setLiveStats, setLoaded, refresh };
}
