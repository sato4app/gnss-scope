// 地点に付ける写真：取り込み（縮小 → JPEG 圧縮）から、追加・削除・サムネイル表示までを持つ。
// 現地の様子を記録に残すためのもので、写真そのものの品質は目的ではない。
// 端末内に貯まり続けるため、**取り込む時点で小さくしてから保存する**（後から縮められない）。
//
// 縮小は長辺の上限（設定 photoMaxEdge）で決め、そのうえで目標バイト数に収まるまで
// JPEG 品質を段階的に落とす。元画像が小さければ拡大はしない。
// EXIF の向きは createImageBitmap の imageOrientation:'from-image' に任せる
// （自前で EXIF を読むと、対応端末ごとの差分を抱え込むため）。
//
// 写真パネルは記録タブの保存フォームに出る（index.html にある静的な要素）。配線は wirePanel()。
import { $, escapeMarkup } from './view-utils.js';

// 目標バイト数。1地点5枚で 1MB 前後に収まる大きさ。
const TARGET_BYTES = 200 * 1024;
// 品質を落とす順。最後まで目標に入らなければ、いちばん低い品質のものを採用する。
const QUALITIES = [0.8, 0.65, 0.5, 0.4];

// 長辺 maxEdge に収まる描画サイズ（拡大はしない）
function fitSize(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (!(longest > maxEdge)) return { w: width, h: height };
  const scale = maxEdge / longest;
  return { w: Math.round(width * scale), h: Math.round(height * scale) };
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// File/Blob → 縮小済みの JPEG Blob（＋実寸）。読めない画像は例外を投げる。
export async function shrinkImage(file, { maxEdge = 1280 } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new Error('画像として読み込めませんでした');
  }
  const { w, h } = fitSize(bitmap.width, bitmap.height, maxEdge);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let blob = null;
  for (const q of QUALITIES) {
    blob = await toBlob(canvas, q);
    if (!blob) throw new Error('画像を変換できませんでした');
    if (blob.size <= TARGET_BYTES) break;
  }
  return { blob, w, h };
}

// 写真パネルの配線一式。settings.photoMaxCount / photoMaxEdge を毎回読むので、
// 設定タブでの変更にそのまま追従する（上限 0 枚なら写真機能ごと出さない）。
export function initPhotoUI({ storage, settings }) {
  // 端末の写真アプリ／カメラを開く。input は1つを使い回すので、選択のたびに
  // 待っている側を差し替える（キャンセルすると change が来ないため解決しないが、
  // 次に開いたときに上書きされるだけで害はない）。
  let pickResolve = null;
  $('file-photo').addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = ''; // 同じ写真を続けて選べるようにする
    pickResolve?.(files);
    pickResolve = null;
  });

  function pick() {
    return new Promise((resolve) => {
      pickResolve = resolve;
      $('file-photo').click();
    });
  }

  // 選んだ写真を縮小して地点へ足す。上限を超えるぶんは取り込まない。
  async function add(sessionId, files) {
    const max = settings.photoMaxCount;
    const room = max - (await storage.getPhotos(sessionId)).length;
    if (room <= 0) {
      alert(`写真は1地点あたり ${max} 枚までです。`);
      return 0;
    }
    let added = 0;
    for (const file of files.slice(0, room)) {
      try {
        const { blob, w, h } = await shrinkImage(file, { maxEdge: settings.photoMaxEdge });
        await storage.addPhoto(sessionId, { blob, w, h });
        added++;
      } catch (e) {
        alert(`写真を取り込めませんでした: ${e.message}`);
      }
    }
    if (files.length > room) alert(`上限 ${max} 枚のため、${files.length - room} 枚は取り込みませんでした。`);
    return added;
  }

  // サムネイル列の描画。objectURL は貼り替えのたびに解放する（貯めると端末を圧迫する）。
  const photoUrls = new Map();
  async function render(stripEl, countEl, sessionId) {
    if (!stripEl) return;
    for (const url of photoUrls.get(stripEl) || []) URL.revokeObjectURL(url);
    const photos = await storage.getPhotos(sessionId);
    const urls = [];
    stripEl.innerHTML = '';
    for (const photo of photos) {
      const url = URL.createObjectURL(photo.blob);
      urls.push(url);
      const div = document.createElement('div');
      div.className = 'photo-thumb';
      div.innerHTML = `<img src="${url}" alt="${escapeMarkup(`${photo.w}×${photo.h}`)}">` +
        `<button type="button" data-photo="${escapeMarkup(photo.id)}" title="削除">×</button>`;
      stripEl.appendChild(div);
    }
    photoUrls.set(stripEl, urls);
    if (countEl) countEl.textContent = `${photos.length} / ${settings.photoMaxCount} 枚`;
  }

  // 「📷 写真を追加」1回ぶん。取り込めたら true（呼び出し側で一覧・容量表示を更新する）
  async function pickAndAdd(sessionId) {
    if (!sessionId) return false;
    const files = await pick();
    return !!files.length && (await add(sessionId, files)) > 0;
  }

  // サムネイルの「×」1回ぶん。消したら true
  async function confirmDelete(sessionId, photoId) {
    if (!confirm('この写真を削除しますか？')) return false;
    await storage.deletePhoto(sessionId, photoId);
    return true;
  }

  // 静的な写真パネル（保存フォーム）の配線
  function wirePanel({ boxEl, addBtn, stripEl, countEl, getSessionId, onChange }) {
    boxEl.hidden = !isEnabled();
    addBtn.addEventListener('click', async () => {
      const sessionId = getSessionId();
      if (!sessionId) return;
      addBtn.disabled = true;
      try {
        if (await pickAndAdd(sessionId)) {
          await render(stripEl, countEl, sessionId);
          await onChange?.();
        }
      } finally {
        addBtn.disabled = false;
      }
    });
    stripEl.addEventListener('click', async (ev) => {
      const photoId = ev.target.dataset?.photo;
      const sessionId = getSessionId();
      if (!photoId || !sessionId) return;
      if (!(await confirmDelete(sessionId, photoId))) return;
      await render(stripEl, countEl, sessionId);
      await onChange?.();
    });
  }

  const isEnabled = () => settings.photoMaxCount > 0;

  return { isEnabled, render, wirePanel };
}
