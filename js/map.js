// 地図タブ：Leaflet ＋ 地理院地図（標準 / 淡色 / 写真）。
//   MapView    : 地図本体（現在地マーカー・水平精度円・軌跡・読込データの表示・追従）
//   initMapUI  : 地図タブの操作配線（追従トグル・読込データへフィット・情報表示）
// 主な役目は「読込データ（load した記録）の GNSS 値をマーカー表示」すること。
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
