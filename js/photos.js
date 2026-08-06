// 地点に付ける写真の取り込み（縮小 → JPEG 圧縮）。
// 現地の様子を記録に残すためのもので、写真そのものの品質は目的ではない。
// 端末内に貯まり続けるため、**取り込む時点で小さくしてから保存する**（後から縮められない）。
//
// 縮小は長辺の上限（設定 photoMaxEdge）で決め、そのうえで目標バイト数に収まるまで
// JPEG 品質を段階的に落とす。元画像が小さければ拡大はしない。
// EXIF の向きは createImageBitmap の imageOrientation:'from-image' に任せる
// （自前で EXIF を読むと、対応端末ごとの差分を抱え込むため）。

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

// バイト数 → 表示文字列。自前で数えた概算値なので「約」を付けて使う。
export function formatBytes(bytes) {
  if (!(bytes > 0)) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
