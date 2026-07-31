// Service Worker：アプリシェルのプリキャッシュ＋地理院地図タイルのキャッシュ。
// タイルは cache-first（オフラインでもキャッシュ済範囲の地図が出る）。
// タイルキャッシュ名は js/tile-cache.js の事前ダウンロードと共有する。

// 版数 'yyyy-mm-dd.n'（更新日 ＋ 同日内の連番。日付が変わったら 1 に戻す）。
// アプリを更新したら必ず改める（この値が変わることで新SWのインストールが走る）。
// 設定タブの「アプリのバージョン」はこの値をそのまま表示する（js/settings-ui.js）。
const APP_VERSION = '2026-07-31.2';
// キャッシュ名は接頭辞つき（activate の掃除で他のキャッシュと区別するため）
const SHELL_CACHE = `gnss-scope-shell-${APP_VERSION}`;
const TILE_CACHE = 'gsi-tiles';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  // 受信: 経路 → 行復元/解析 → エポック → 受信品質
  './js/app.js',
  './js/transport.js',
  './js/nmea.js',
  './js/epoch.js',
  './js/stream-stats.js',
  // 解析・記録
  './js/accuracy.js',
  './js/charts.js',
  './js/recorder.js',
  './js/device-gnss.js',
  './js/survey.js',
  './js/storage.js',
  './js/file-io.js',
  // 画面
  './js/view-utils.js',
  './js/connect-ui.js',
  './js/record-ui.js',
  './js/analysis-ui.js',
  './js/map.js',
  './js/settings-ui.js',
  './js/tile-cache.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('gnss-scope-shell-') && k !== SHELL_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// 設定タブからのバージョン問い合わせに応答する（js/settings-ui.js）
self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: APP_VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // sw.js 自体はキャッシュしない（情報タブの「最新バージョン」確認を妨げないため）
  if (url.origin === self.location.origin && url.pathname.endsWith('/sw.js')) return;

  // 地理院地図タイル：cache-first。未キャッシュ時のみ取得し TILE_CACHE へ格納。
  if (url.hostname === 'cyberjapandata.gsi.go.jp') {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch (e) {
          // オフラインで未キャッシュ → 透明扱いのエラー応答（Leaflet 側でグレー表示）
          return new Response('', { status: 504, statusText: 'tile offline' });
        }
      })
    );
    return;
  }

  // アプリシェル（同一オリジン GET）：cache-first＋ネットワークフォールバック
  if (event.request.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            // data/tile_manifest.json など後から取得するファイルもシェルキャッシュに足す
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
            }
            return res;
          })
      )
    );
  }
});
