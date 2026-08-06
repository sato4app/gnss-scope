// 設定タブの配線：測位・記録パラメータ / 地点の写真 / 地図種別 / ライブ軌跡 ON-OFF と、
// 「アプリのバージョン」（sw.js の APP_VERSION）の確認・更新。
// 設定値は settings オブジェクトを直接書き換えるだけで、永続化はしない。
// 既定値は js/constants.js が唯一の出所で、リロードするとそこへ戻る。
// 同じタブ内でも、タイル事前DL は tile-cache.js、モック配信は connect-ui.js、
// Wake Lock 表示は record-ui.js が担当する（機能ごとにまとめる方針）。
import { $ } from './view-utils.js';
import { DEFAULT_SETTINGS } from './constants.js';

// sw.js の版数 APP_VERSION（'yyyy-mm-dd.n' 形式）を読み取る
const VERSION_RE = /APP_VERSION\s*=\s*'([^']+)'/;
const CACHE_PREFIX = 'gnss-scope-shell-';

// 表示・比較は接頭辞なしの版数で行う。
// 旧SW（版数ではなくキャッシュ名を返す）やキャッシュ名から拾った場合に備えて外す。
const bareVersion = (v) => (v ? v.replace(CACHE_PREFIX, '') : null);

// 新旧比較用の数値。'yyyy-mm-dd.n' → yyyymmddnnnn。
// 読めない旧形式（'v3' など）は 0＝最も古い扱いにする。
function versionOrder(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/.exec(bareVersion(v) || '');
  return m ? +(m[1] + m[2] + m[3] + m[4].padStart(4, '0')) : 0;
}

export function initSettingsUI({ settings, mapView, onPhotoLimitChange }) {
  // ---- 設定行 ----
  // [入力要素 id, settings のキー, 入力値 → 保存値の変換] を1か所に集約する
  const NUMBER_ROWS = [
    ['set-uere', 'uere', (v, d) => Math.max(1, v || d)],
    ['set-minsec', 'minSec', (v, d) => Math.max(0, v >= 0 ? v : d)],
    ['set-maxsec', 'maxSec', (v) => Math.max(0, v || 0)],
    ['set-maxepochs', 'maxEpochs', (v) => Math.max(0, v || 0)],
    // 写真は端末内に貯まり続けるので、上限は現実的な範囲へ丸める（0 = 写真を使わない）
    ['set-photomax', 'photoMaxCount', (v) => Math.min(20, Math.max(0, v || 0))],
  ];
  // 値を持つラジオ（選択肢が決まっているもの）。[name, settings のキー, 値の変換]
  const RADIO_ROWS = [
    ['maptype', 'mapType', (v) => v, (v) => mapView.setBaseLayer(v)],
    ['photoedge', 'photoMaxEdge', (v) => +v, null],
  ];
  const CHECK_ROWS = [
    ['set-autostop', 'autoStop', null],
    ['set-beep', 'beep', null],
    ['set-devgnss', 'deviceGnss', null],
    ['set-saveraw', 'saveRawNmea', null],
    ['set-track', 'trackEnabled', (on) => mapView.setTrackEnabled(on)],
  ];

  for (const [id, key, normalize] of NUMBER_ROWS) {
    $(id).value = settings[key];
    $(id).addEventListener('change', (e) => {
      settings[key] = normalize(+e.target.value, DEFAULT_SETTINGS[key]);
      $(id).value = settings[key];
      // 上限枚数を 0 にすると写真UIごと消えるため、記録タブへ知らせる
      if (key === 'photoMaxCount') onPhotoLimitChange?.();
    });
  }

  for (const [id, key, apply] of CHECK_ROWS) {
    $(id).checked = settings[key];
    $(id).addEventListener('change', (e) => {
      settings[key] = e.target.checked;
      if (apply) apply(settings[key]);
    });
  }

  for (const [name, key, parse, apply] of RADIO_ROWS) {
    const current = document.querySelector(`input[name="${name}"][value="${settings[key]}"]`);
    if (current) current.checked = true;
    for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
      radio.addEventListener('change', (e) => {
        settings[key] = parse(e.target.value);
        apply?.(settings[key]);
      });
    }
  }

  // ---- アプリのバージョン確認・更新 ----
  // 「現行（動作中のSW）」と「最新（サーバー上の sw.js）」を比べ、差があれば更新を confirm する。
  // sw.js は skipWaiting + clients.claim のため、ページ表示中に新SWへ自動で切り替わることがある。
  // その場合も controllerchange で検知して再読み込みを confirm する。
  let confirmedVersion = null; // 同じバージョンで confirm を繰り返さないため
  let updating = false; // 「アプリを更新」実行中（controllerchange で即リロードする）
  let needsReload = false; // 新SWは有効化済みだが、ページの再読み込みを保留している状態

  // 初回インストールやハードリロード直後（未制御で開始）は clients.claim でも
  // controllerchange が発火するが、ページ自体が新しいので確認不要。
  const hadController = !!navigator.serviceWorker?.controller;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updating) {
        location.reload();
        return;
      }
      if (!hadController) return;
      needsReload = true;
      if (confirm('アプリが新しいバージョンに更新されました。再読み込みして反映しますか？')) {
        location.reload();
      }
    });
  }

  // 現行バージョン：動作中のSWに postMessage で問い合わせる。
  // 旧SW（応答ハンドラなし）はタイムアウトするため、シェルキャッシュ名でフォールバック。
  async function getCurrentVersion() {
    if (!('serviceWorker' in navigator)) return null;
    const ctrl = navigator.serviceWorker.controller;
    if (ctrl) {
      const version = await new Promise((resolve) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 1500);
        ch.port1.onmessage = (e) => {
          clearTimeout(timer);
          resolve(e.data?.version || null);
        };
        ctrl.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
      });
      if (version) return bareVersion(version);
    }
    try {
      const keys = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX));
      // 新旧が同居する一瞬は古い方（＝制御中のSW）を採用する
      keys.sort((a, b) => versionOrder(a) - versionOrder(b));
      return bareVersion(keys[0]);
    } catch (e) {
      return null;
    }
  }

  // 最新バージョン：サーバー上の sw.js を取得して APP_VERSION 定数を読む。
  // クエリ付き＋no-store で、SWのキャッシュにもHTTPキャッシュにも当てない。
  async function getLatestVersion() {
    const res = await fetch(`sw.js?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = (await res.text()).match(VERSION_RE);
    return m ? m[1] : null;
  }

  // 更新の適用：SWの更新チェックを起動し、新SWが有効化されたら再読み込み。
  async function applyUpdate() {
    if (updating) return;
    if (needsReload) {
      location.reload();
      return;
    }
    updating = true;
    $('btn-update-apply').hidden = true;
    $('info-update-state').textContent = '更新中…（新しいバージョンの取得が完了すると再読み込みします）';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        location.reload();
        return;
      }
      // 新SWは install 内の skipWaiting で自動的に有効化され、controllerchange で再読み込みされる
      await reg.update();
    } catch (e) {
      updating = false;
      $('btn-update-apply').hidden = false;
      $('info-update-state').textContent = `更新に失敗しました: ${e.message}`;
    }
  }

  // バージョン表示の更新。askConfirm=true なら更新検出時に confirm する（タブを開いたとき）。
  async function refreshVersion({ askConfirm = true } = {}) {
    const stateEl = $('info-update-state');
    const applyBtn = $('btn-update-apply');
    if (updating) return;
    stateEl.textContent = '確認中…';
    applyBtn.hidden = true;

    const current = await getCurrentVersion();
    $('info-sw-current').textContent = current || '不明';

    let latest = null;
    try {
      latest = await getLatestVersion();
    } catch (e) {
      $('info-sw-latest').textContent = '取得失敗';
      stateEl.textContent = '最新バージョンを取得できませんでした（オフラインの可能性があります）。';
      return;
    }
    $('info-sw-latest').textContent = latest || '不明';
    if (!latest) {
      stateEl.textContent = 'sw.js からバージョンを読み取れませんでした。';
      return;
    }

    if (needsReload) {
      // 新SWは適用済み。再読み込みだけが未実施
      stateEl.textContent = '新しいバージョンが適用済みです。再読み込みで反映されます。';
      applyBtn.textContent = '再読み込み';
      applyBtn.hidden = false;
      return;
    }
    if (!current) {
      stateEl.textContent = '現行バージョンを取得できませんでした（初回起動直後の可能性があります）。';
      return;
    }
    if (latest === current) {
      stateEl.textContent = '最新の状態です。';
      return;
    }

    stateEl.textContent = '新しいバージョンがあります。';
    applyBtn.textContent = 'アプリを更新';
    applyBtn.hidden = false;
    if (askConfirm && confirmedVersion !== latest) {
      confirmedVersion = latest; // キャンセルされたら次回タブを開いても confirm しない（ボタンから更新可能）
      if (confirm(`新しいバージョン（${latest}）があります。アプリを更新しますか？`)) {
        await applyUpdate();
      }
    }
  }

  $('btn-update-check').addEventListener('click', () => refreshVersion({ askConfirm: true }));
  $('btn-update-apply').addEventListener('click', () => applyUpdate());

  return { refreshVersion };
}
