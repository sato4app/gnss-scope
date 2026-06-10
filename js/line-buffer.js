// WebSocket フレームと NMEA の1行は一致しない。実機の取り扱いは2系統ある：
//   (A) Pico W の main.py：1フレーム＝1行（strip 済み・改行なし）で送る
//   (B) 改行区切りのバイト列が、フレーム境界でぶつ切りに割れて届く
// どちらでも正しく行を取り出せるよう、改行に加えて NMEA のチェックサム(*XX)で
// 行末を判定する。

const NMEA_END = /\*[0-9A-Fa-f]{2}$/; // 完結した NMEA 文の末尾（チェックサム）

export class LineBuffer {
  constructor() {
    this.buf = '';
  }

  // フレーム文字列を投入し、完成した行（空行除く）の配列を返す
  push(chunk) {
    this.buf += chunk;
    const out = [];

    // (B) 改行があれば、その手前までを行として確定。末尾断片は持ち越す。
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop();
    for (const p of parts) {
      const t = p.trim();
      if (t) out.push(t);
    }

    // (A) 改行が無くても、*XX で終わっていれば完結した1文として確定。
    //     （途中までの断片は *XX に一致しないので持ち越される）
    const rest = this.buf.trim();
    if (rest && NMEA_END.test(rest)) {
      out.push(rest);
      this.buf = '';
    }

    return out;
  }

  // 接続終了時などに残りを吐き出す
  flush() {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}
