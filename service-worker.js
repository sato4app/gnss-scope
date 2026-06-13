// PWA Service Worker：アプリ一式を事前キャッシュし、オフライン（PC・電波圏外）でも
// 起動できるようにする。GitHub Pages のサブパス配信を想定し、パスは全て相対で書く。
//
// 配信戦略は stale-while-revalidate：
//   キャッシュがあれば即返し、裏でネットワークから取り直してキャッシュを更新する。
//   → 圏外でも瞬時に開き、オンラインなら次回表示で最新版になる。
// BLE/WebSocket のライブデータは fetch を通らないので、この SW の影響を受けない。

const CACHE_NAME = 'gnss-scope-v3';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/line-buffer.js',
  './js/nmea.js',
  './js/epoch.js',
  './js/ble-client.js',
  './js/recorder.js',
  './js/views/view-utils.js',
  './js/views/fix-status.js',
  './js/views/sky-plot.js',
  './js/views/snr-chart.js',
  './js/views/timeseries.js',
  './js/views/data-quality.js',
  './js/dev/mock-feeder.js',
  './vendor/uplot/uPlot.iife.min.js',
  './vendor/uplot/uPlot.min.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部リソースは扱わない（現在は無し）

  ev.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      // 裏で取り直してキャッシュ更新（オフライン時は静かに失敗）
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) return cached;
      const fresh = await refresh;
      if (fresh) return fresh;
      // 圏外で未キャッシュのナビゲーション → アプリ本体へフォールバック
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('offline', { status: 503, statusText: 'offline' });
    })
  );
});
