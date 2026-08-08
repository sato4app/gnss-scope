// 設定タブの配線：測位・記録パラメータ / 地点の写真 / 地図種別 / ライブ軌跡 ON-OFF と、
// 「アプリのバージョン」（sw.js の APP_VERSION）の確認・更新。
// 設定値は settings オブジェクトを直接書き換えるだけで、永続化はしない。
// 既定値は js/constants.js が唯一の出所で、リロードするとそこへ戻る。
// 同じタブ内でも、タイル事前DL は map.js、モック配信は connect-ui.js、
// Wake Lock 表示は record-ui.js が担当する（機能ごとにまとめる方針）。
import { $, formatBytes } from './view-utils.js';
import { DEFAULT_SETTINGS, PHOTO_EDGE_OPTIONS } from './constants.js';

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

// storage / recorder: 「端末内のデータを全消去」で使う
// onRecordsCleared: 消した後の後始末（読込データの解除・一覧と容量表示の作り直し）
export function initSettingsUI({ settings, mapView, storage, recorder, onPhotoLimitChange, onRecordsCleared }) {
  // 写真の長辺の選択肢は js/constants.js の PHOTO_EDGE_OPTIONS が唯一の出所。
  // 画面にも直書きしないよう、ラジオはここで組み立てる。
  $('photoedge-options').innerHTML = PHOTO_EDGE_OPTIONS.map(
    (px) => `<label><input type="radio" name="photoedge" value="${px}">${px}</label>`
  ).join('');

  // ---- 設定行 ----
  // [種類, 入力の指定（id / ラジオの name）, settings のキー, 入力値→保存値, 保存後の反映]
  // 種類ごとに読み書きするプロパティが違うだけなので、定義テーブル ＋ 1ループで配線する。
  const NUMBER = 'number';
  const CHECK = 'check';
  const RADIO = 'radio';
  const ROWS = [
    [NUMBER, 'set-uere', 'uere', (v, d) => Math.max(1, v || d)],
    [NUMBER, 'set-minsec', 'minSec', (v, d) => Math.max(0, v >= 0 ? v : d)],
    [NUMBER, 'set-maxsec', 'maxSec', (v) => Math.max(0, v || 0)],
    [NUMBER, 'set-maxepochs', 'maxEpochs', (v) => Math.max(0, v || 0)],
    // 写真は端末内に貯まり続けるので、上限は現実的な範囲へ丸める（0 = 写真を使わない）。
    // 0 にすると写真UIごと消えるため、記録タブへ知らせる。
    [NUMBER, 'set-photomax', 'photoMaxCount', (v) => Math.min(20, Math.max(0, v || 0)), () => onPhotoLimitChange?.()],
    [CHECK, 'set-autostop', 'autoStop'],
    [CHECK, 'set-beep', 'beep'],
    [CHECK, 'set-devgnss', 'deviceGnss'],
    [CHECK, 'set-saveraw', 'saveRawNmea'],
    [CHECK, 'set-track', 'trackEnabled', null, (on) => mapView.setTrackEnabled(on)],
    [RADIO, 'maptype', 'mapType', (v) => v, (v) => mapView.setBaseLayer(v)],
    [RADIO, 'photoedge', 'photoMaxEdge', (v) => +v],
  ];

  for (const [kind, target, key, parse, apply] of ROWS) {
    const inputs =
      kind === RADIO ? [...document.querySelectorAll(`input[name="${target}"]`)] : [$(target)];

    // 現在値を画面へ
    if (kind === RADIO) for (const el of inputs) el.checked = el.value === String(settings[key]);
    else if (kind === CHECK) inputs[0].checked = settings[key];
    else inputs[0].value = settings[key];

    for (const el of inputs) {
      el.addEventListener('change', () => {
        if (kind === CHECK) settings[key] = el.checked;
        else if (kind === RADIO) settings[key] = parse(el.value);
        else {
          settings[key] = parse(+el.value, DEFAULT_SETTINGS[key]);
          el.value = settings[key]; // 丸めた値を画面へ戻す
        }
        apply?.(settings[key]);
      });
    }
  }

  // ---- 端末内のデータを全消去 ----
  // 日単位の削除は一覧タブ（「日ごと削除」）にある。ここはその上位で、端末を
  // まっさらにするための操作。危険な操作なので、危険だと分かる場所に置き、
  // **失うものを数えて見せてから**実行する。
  // 確認を常に2回にはしない（全部書き出し済みの端末で毎回2回聞かれると、
  // 確認そのものが読まれなくなる）。復元できないものがあるときだけ止める。
  $('btn-clear-records').addEventListener('click', async () => {
    if (recorder?.isRecording) {
      alert('記録中は消去できません。停止してから実行してください。');
      return;
    }
    let usage;
    try {
      usage = await storage.getStorageUsage();
    } catch (e) {
      alert(`端末内のデータを読めませんでした: ${e.message}`);
      return;
    }
    if (!usage.surveys) {
      alert('端末内に記録はありません。');
      return;
    }
    const what =
      `${usage.surveys} 日 / ${usage.points} 地点` +
      (usage.drafts ? ` と下書き ${usage.drafts} 件` : '') +
      ` / 約 ${formatBytes(usage.total)}`;
    if (!confirm(`端末内の記録をすべて削除します。\n${what}\n\n元に戻せません。`)) return;
    if (
      usage.unexported > 0 &&
      !confirm(
        `未書き出しの調査日が ${usage.unexportedSurveys} 日（約 ${formatBytes(usage.unexported)}）あります。\n` +
          '書き出していないデータは復元できません。本当に削除しますか？'
      )
    ) {
      return;
    }
    try {
      await storage.clearRecords();
    } catch (e) {
      alert(`削除に失敗しました: ${e.message}`);
      return;
    }
    await onRecordsCleared?.();
    alert('端末内の記録を削除しました。');
  });

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
