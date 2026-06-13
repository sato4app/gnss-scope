// ビュー共通のユーティリティ。
// 各キャンバスビュー（スカイプロット・SNR・データ品質）で重複していた
// 「DPR対応リサイズ＋ウィンドウリサイズ時の再描画」と、
// 「使用衛星PRNセットの生成」をここに集約する。

// キャンバスを devicePixelRatio に合わせて初期化し、ウィンドウリサイズで
// 再設定＋redraw() を呼ぶ。返す size オブジェクトは常に最新の CSSピクセル寸法を持つ。
//   square: true なら幅・高さの小さい方に合わせた正方形にする（スカイプロット用）
export function setupHiDpiCanvas(canvas, redraw, { square = false, fallbackW = 600, fallbackH = 200 } = {}) {
  const ctx = canvas.getContext('2d');
  const size = { w: 0, h: 0 };
  const resize = () => {
    let w = canvas.clientWidth || fallbackW;
    let h = canvas.clientHeight || fallbackH;
    if (square) w = h = Math.min(w, h);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    size.w = w;
    size.h = h;
  };
  resize();
  window.addEventListener('resize', () => {
    resize();
    redraw();
  });
  return { ctx, size };
}

// エポックの使用衛星（GSA）から PRN の Set を作る。
// NMEA拡張のPRN番号はコンステレーション間でほぼ一意なのでPRNで照合する。
export function usedPrnSet(epoch) {
  return new Set((epoch.usedSVs || []).map((u) => u.prn));
}
