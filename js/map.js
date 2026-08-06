// 地図まわり一式（Leaflet ＋ 地理院地図の標準 / 淡色 / 写真）。
//   MapView      : 地図本体（現在地マーカー・水平精度円・軌跡・読込データの表示・追従）
//   initMapUI    : 地図タブの操作配線（追従トグル・読込データへフィット・情報表示）
//   TileCache    : オフライン用タイルの事前ダウンロード（Cache API）
//   initTileUI   : 設定タブ内の事前DL UI
// 地図の主な役目は「読込データ（load した記録）の GNSS 値をマーカー表示」すること。
// タイル事前DL は置き場所こそ設定タブだが、URL テンプレート（GSI_LAYERS）も
// 地図種別も地図と同じものを見るため、同じファイルに置く。
// Leaflet はローカル配置（vendor/leaflet/）の script タグで読み込み、グローバル L を使う。
/* global L */
import { $ } from './view-utils.js';

export const GSI_LAYERS = {
  std: {
    label: '標準地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    maxZoom: 18,
  },
  pale: {
    label: '淡色地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    maxZoom: 18,
  },
  photo: {
    label: '写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    maxZoom: 18,
  },
};

const GSI_ATTRIBUTION = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>';

// 初期地図中心: 箕面大滝（CLAUDE.md の規約に従う）
const DEFAULT_CENTER = [34.853667, 135.472041];
const DEFAULT_ZOOM = 17; // 既定ズーム z=17

const LIVE_COLOR = '#4f9dff'; // 現在地・精度円・軌跡
const CENTER_COLOR = '#36c98d'; // 読込データの中心・DRMS 円
const EPOCH_COLOR = '#f0a93a'; // 読込データの各エポック

export class MapView {
  constructor(el, { mapType = 'std', trackEnabled = true, follow = true } = {}) {
    this.map = L.map(el, { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, zoomControl: true });
    this.baseLayer = null;
    this.setBaseLayer(mapType);

    this.follow = follow;
    this.trackEnabled = trackEnabled;

    this.posMarker = null; // 現在地マーカー
    this.accCircle = null; // 水平精度円
    this.track = L.polyline([], { color: LIVE_COLOR, weight: 3, opacity: 0.7 }).addTo(this.map);
    this.loadedLayer = L.layerGroup().addTo(this.map); // 読込データ（中心マーカー＋エポック点群）
    this.loadedBounds = null; // 読込データの表示範囲（「読込データへ」ボタン用）

    // ユーザーが手で地図を動かしたら追従を切る（onFollowChange で UI に通知）
    this.onFollowChange = () => {};
    this.map.on('dragstart', () => {
      if (this.follow) this.setFollow(false);
    });
  }

  setBaseLayer(type) {
    const def = GSI_LAYERS[type] || GSI_LAYERS.std;
    if (this.baseLayer) this.map.removeLayer(this.baseLayer);
    this.baseLayer = L.tileLayer(def.url, { maxZoom: def.maxZoom, attribution: GSI_ATTRIBUTION }).addTo(this.map);
  }

  setFollow(on) {
    this.follow = on;
    this.onFollowChange(on);
  }

  setTrackEnabled(on) {
    this.trackEnabled = on;
    if (!on) this.track.setLatLngs([]);
  }

  // 現在地＋精度円を更新。accM は推定水平精度 [m]（null なら円を消す）
  updatePosition(lat, lon, accM) {
    const ll = [lat, lon];
    if (!this.posMarker) {
      this.posMarker = L.circleMarker(ll, {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: LIVE_COLOR,
        fillOpacity: 1,
      }).addTo(this.map);
    } else {
      this.posMarker.setLatLng(ll);
    }

    if (accM != null && accM > 0) {
      if (!this.accCircle) {
        this.accCircle = L.circle(ll, {
          radius: accM,
          color: LIVE_COLOR,
          weight: 1,
          fillColor: LIVE_COLOR,
          fillOpacity: 0.15,
        }).addTo(this.map);
      } else {
        this.accCircle.setLatLng(ll);
        this.accCircle.setRadius(accM);
      }
    } else if (this.accCircle) {
      this.map.removeLayer(this.accCircle);
      this.accCircle = null;
    }

    if (this.trackEnabled) this.track.addLatLng(ll);
    if (this.follow) this.map.panTo(ll, { animate: false });
  }

  // 読込データ（{ session, point }）の表示。null でクリア。
  showLoaded(entry) {
    this.loadedLayer.clearLayers();
    this.loadedBounds = null;
    if (!entry) return;

    const { session, point } = entry;
    const latlngs = [];
    for (const s of point?.samples || []) {
      if (s.lat == null || s.lon == null) continue;
      latlngs.push([s.lat, s.lon]);
      L.circleMarker([s.lat, s.lon], {
        radius: 2.5,
        color: EPOCH_COLOR,
        weight: 0,
        fillColor: EPOCH_COLOR,
        fillOpacity: 0.7,
      }).addTo(this.loadedLayer);
    }

    const center = point?.stats?.center || session.summary || {};
    if (center.lat != null && center.lon != null) {
      latlngs.push([center.lat, center.lon]);
      const drms = point?.stats?.drms ?? session.summary?.drms;
      // ばらつき（DRMS）の円も重ねる：地図上でも精度が体感できるように
      if (drms > 0) {
        L.circle([center.lat, center.lon], {
          radius: drms,
          color: CENTER_COLOR,
          weight: 1,
          fillColor: CENTER_COLOR,
          fillOpacity: 0.12,
        }).addTo(this.loadedLayer);
      }
      L.circleMarker([center.lat, center.lon], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: CENTER_COLOR,
        fillOpacity: 1,
      })
        .bindPopup(
          `<b>${session.label}</b><br>${center.lat.toFixed(7)}, ${center.lon.toFixed(7)}` +
            (drms != null ? `<br>DRMS ${drms.toFixed(2)} m` : '')
        )
        .addTo(this.loadedLayer);
    }

    if (latlngs.length) this.loadedBounds = L.latLngBounds(latlngs);
    this.fitLoaded();
  }

  // 読込データが収まるように表示を合わせる（点群が密なため最大ズームは制限する）
  fitLoaded() {
    if (!this.loadedBounds) return;
    this.setFollow(false);
    this.map.fitBounds(this.loadedBounds, { padding: [40, 40], maxZoom: DEFAULT_ZOOM });
  }

  invalidateSize() {
    this.map.invalidateSize();
  }
}

// ---- 地図タブの操作配線 ----
// 地図はメイン画面ではなく1タブなので、表示されたタイミングで invalidateSize() を
// 呼んでサイズを確定させる必要がある（onShow）。
export function initMapUI({ mapView }) {
  let loaded = null;

  $('btn-follow').addEventListener('click', () => mapView.setFollow(!mapView.follow));
  mapView.onFollowChange = (on) => $('btn-follow').classList.toggle('active', on);
  $('btn-fit-loaded').addEventListener('click', () => mapView.fitLoaded());
  $('btn-fit-loaded').disabled = true;

  // 読込データの差し替え（null でクリア）
  function setLoaded(entry) {
    loaded = entry;
    mapView.showLoaded(entry);
    $('btn-fit-loaded').disabled = !entry;
    const s = entry?.session;
    const summary = s?.summary;
    $('map-info').textContent = s
      ? `読込: ${s.label}（${summary?.count ?? entry.point.samples?.length ?? 0}点` +
        (summary?.drms != null ? ` / DRMS ${summary.drms.toFixed(2)}m` : '') +
        '）'
      : '読込データなし';
  }

  function onShow() {
    mapView.invalidateSize();
    if (loaded) mapView.fitLoaded();
  }

  return { setLoaded, onShow };
}

// ---- オフライン地図タイルの事前ダウンロード ----
// data/tile_manifest.json（Format A：座標リスト JSON 方式）記載のタイルを
// Cache API（sw.js と同じ 'gsi-tiles' キャッシュ）へ一括取得する。
// マニフェストは data/ を唯一の置き場とし、ルート直下には複製を置かない（重複回避）。
// オフライン時は SW がこのキャッシュからタイルを返す。

const TILE_CACHE_NAME = 'gsi-tiles';
const CONCURRENCY = 4; // 地理院サーバへの負荷を抑える

export class TileCache {
  constructor() {
    this.aborter = null;
  }

  static isSupported() {
    return typeof caches !== 'undefined';
  }

  // マニフェスト形式: { version, layers: { <key>: { z: 17, tiles: [[x, y], ...] }, ... } }
  async loadManifest(url = 'data/tile_manifest.json') {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url} を取得できません (${res.status})`);
    return res.json();
  }

  // マニフェスト内のタイル URL を列挙（mapType で URL テンプレートを切替）
  tileUrls(manifest, mapType = 'std') {
    const def = GSI_LAYERS[mapType] || GSI_LAYERS.std;
    const urls = [];
    for (const layer of Object.values(manifest.layers || {})) {
      for (const [x, y] of layer.tiles || []) {
        urls.push(def.url.replace('{z}', layer.z).replace('{x}', x).replace('{y}', y));
      }
    }
    return urls;
  }

  // マニフェスト記載のタイルを一括取得する。onProgress({done, total, failed}) で進捗を通知。
  async download(manifest, { mapType = 'std', onProgress = () => {} } = {}) {
    if (!TileCache.isSupported()) throw new Error('Cache API 非対応の環境です');
    const cache = await caches.open(TILE_CACHE_NAME);
    this.aborter = new AbortController();
    const signal = this.aborter.signal;

    const urls = this.tileUrls(manifest, mapType);
    const total = urls.length;
    let done = 0;
    let failed = 0;
    let idx = 0;

    const worker = async () => {
      while (idx < urls.length) {
        if (signal.aborted) return;
        const url = urls[idx++];
        try {
          // キャッシュ済みはスキップ
          const hit = await cache.match(url);
          if (!hit) {
            const res = await fetch(url, { signal });
            if (res.ok) await cache.put(url, res);
            else failed++;
          }
        } catch (e) {
          if (signal.aborted) return;
          failed++;
        }
        done++;
        onProgress({ done, total, failed });
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    this.aborter = null;
    return { done, total, failed, cancelled: signal.aborted };
  }

  cancel() {
    if (this.aborter) this.aborter.abort();
  }

  // 現在のタイルキャッシュ件数（目安表示用）
  async cachedCount() {
    if (!TileCache.isSupported()) return 0;
    const cache = await caches.open(TILE_CACHE_NAME);
    return (await cache.keys()).length;
  }
}

// ---- 設定タブ内の事前ダウンロード UI ----
// getMapType: 現在の地図種別を返す関数（設定変更に追従するため関数で受ける）
export function initTileUI({ tileCache, storage, getMapType }) {
  const mapLabel = (type) => GSI_LAYERS[type]?.label || type || '標準地図';

  // ダウンロード済みタイルの枚数と、data/tile_manifest.json の version を表示。
  // version・地図種別・取得日時はダウンロード時に IndexedDB(settings) へ記録した値を使う
  // （オフライン起動でもネットワーク無しで表示できる）。枚数は実キャッシュ件数。
  async function refreshTileStatus() {
    const count = await tileCache.cachedCount();
    const meta = await storage.getSetting('tileCacheMeta', null);
    if (!count) {
      $('tile-status').textContent = 'ダウンロード済みタイル: なし';
      return;
    }
    let text = `ダウンロード済みタイル: ${count} 枚`;
    if (meta?.version) text += ` ／ version ${meta.version}`;
    if (meta?.mapType) text += `（${mapLabel(meta.mapType)}）`;
    if (meta?.downloadedAt) text += `　${new Date(meta.downloadedAt).toLocaleString('ja-JP')} 取得`;
    $('tile-status').textContent = text;
  }

  $('btn-tiledl').addEventListener('click', async () => {
    const progressEl = $('tiledl-progress');
    const mapType = getMapType();
    let manifest;
    try {
      manifest = await tileCache.loadManifest();
    } catch (e) {
      progressEl.textContent = `マニフェスト読込失敗: ${e.message}`;
      return;
    }
    const total = tileCache.tileUrls(manifest).length;
    if (!total) {
      progressEl.textContent = 'マニフェストにタイルがありません';
      return;
    }
    if (!confirm(`${total} 枚のタイルをダウンロードしますか？（${mapLabel(mapType)}）`)) return;

    $('btn-tiledl').disabled = true;
    $('btn-tiledl-cancel').hidden = false;
    try {
      const result = await tileCache.download(manifest, {
        mapType,
        onProgress: ({ done, failed }) => {
          progressEl.textContent = `ダウンロード中… ${done}/${total}${failed ? `（失敗 ${failed}）` : ''}`;
        },
      });
      progressEl.textContent = result.cancelled
        ? `中止しました（${result.done}/${result.total}）`
        : `完了: ${result.done}/${result.total}${result.failed ? `（失敗 ${result.failed}）` : ''}`;
      // 1枚でも取得できたら、その時点の data/tile_manifest.json の version を記録する
      if (result.done > 0) {
        await storage.setSetting('tileCacheMeta', {
          version: manifest.version ?? null,
          mapType,
          downloadedAt: Date.now(),
          downloaded: result.done,
          cancelled: result.cancelled,
        });
      }
      await refreshTileStatus();
    } catch (e) {
      progressEl.textContent = `エラー: ${e.message}`;
    } finally {
      $('btn-tiledl').disabled = false;
      $('btn-tiledl-cancel').hidden = true;
    }
  });

  $('btn-tiledl-cancel').addEventListener('click', () => tileCache.cancel());

  // Cache API が使えない環境（プライベートモード等）でも起動を妨げないようにする
  refreshTileStatus().catch(() => {
    $('tile-status').textContent = 'ダウンロード済みタイル: 確認できません（Cache API 利用不可）';
    $('btn-tiledl').disabled = true;
  });
}
