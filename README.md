# GNSS Scope (M10S / NMEA over WebSocket)

PicoW + MAX-M10S が WebSocket で流す生 NMEA を受け、Fix 状態・スカイプロット・SNR を
リアルタイム表示する Vanilla JS（ES モジュール）の受信基盤＋ライブ表示。

## 構成

```
gnss-monitor/
  index.html
  css/style.css
  js/
    nmea.js          NMEAパーサ（GGA/RMC/GSA/GSV）＋チェックサム
    line-buffer.js   WSフレームを改行で行に再分割（断片結合）
    epoch.js         同一時刻のセンテンスを1エポックに集約
    ws-client.js     WebSocket接続（指数バックオフで自動再接続）
    recorder.js      生フレームをIndexedDBに収録（再生用）
    app.js           配線：WS→行バッファ→収録→パース→集約→3ビュー
    views/
      fix-status.js  測位品質・DOP・座標・有効測位率
      sky-plot.js    極座標の衛星配置（使用/可視、SNRで大きさ）
      snr-chart.js   衛星ごとのC/N0棒グラフ
    dev/
      mock-feeder.js 開発用デモ生成器（Picoなしで動作確認）
```

データの流れ：`WS受信 → 行バッファ → 収録 → パース＋検証 → エポック確定 → 3ビュー更新`。

## ローカルで動かす

ES モジュールを使うので `file://` 直開きでは動きません。HTTP で配信してください。

```
cd gnss-monitor
python3 -m http.server 8000
# ブラウザで http://localhost:8000
```

「デモ再生」を押すと Pico なしでも動作確認できます（箕面付近の座標で合成 NMEA を 1Hz 生成）。

## Pico に繋ぐ

1. Pico 側を WebSocket サーバにして、M10S の NMEA をそのまま（または複数行まとめて）
   テキストフレームで送る。送信単位は行に揃わなくてよい（こちらで再分割します）。
2. 上部の入力欄に `ws://<PicoのIP>:<ポート>` を入れて「接続」。
3. 切断されても自動で再接続します（接続状態は右上に表示）。

### 重要：HTTPS と ws:// の組み合わせは不可

HTTPS のページ（Vercel 等）からは `ws://`（非暗号化）に接続できません（mixed content で
ブラウザが遮断）。現場でライブ取り込みするときは、この画面を `http://localhost` か
LAN 内の HTTP サーバから開いて `ws://<PicoのIP>` に繋いでください。
本番（HTTPS）は収録済みデータの解析・共有用、と役割を分けると素直です。

## 収録と再生

「収録開始」で受信した生行を IndexedDB（`gnssMonitorDB`）に時刻つきで保存します。
保存した行は同じパーサ／集約器に流せば再解析できます（再生UIは今後の拡張ポイント）：

```js
import { Recorder } from './js/recorder.js';
import { parseSentence } from './js/nmea.js';
import { EpochAssembler } from './js/epoch.js';

const rec = new Recorder();
const sessions = await rec.listSessions();
const lines = await rec.loadLines(sessions[0].id);
const asm = new EpochAssembler({ onEpoch: (e) => { /* 解析・描画 */ } });
for (const { line } of lines) asm.add(parseSentence(line));
asm.flush();
```

## 既知のメモ

- 「使用衛星」の照合は PRN 番号で行っています（NMEA 拡張番号はコンステ間でほぼ一意）。
  GSA に systemId（NMEA 4.10+）が出ていれば系別もより正確になります。
- M10S 側で GSA/GSV（各 GNSS）や GST が出力されているか u-center / UBX-CFG で確認を。
  本基盤は GGA/RMC/GSA/GSV を使用。精度の深掘り（GST の誤差統計）は次段の拡張で。
```
