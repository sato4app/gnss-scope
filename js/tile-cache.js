// オフライン地図タイルの事前ダウンロード（設定タブ）。
// data/tile_manifest.json（Format A：座標リスト JSON 方式）記載のタイルを
// Cache API（sw.js と同じ 'gsi-tiles' キャッシュ）へ一括取得する。
// マニフェストは data/ を唯一の置き場とし、ルート直下には複製を置かない（重複回避）。
// オフライン時は SW がこのキャッシュからタイルを返す。
import { $ } from './view-utils.js';
import { GSI_LAYERS } from './map.js';

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
