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
    ws-client.js     WebSocket接続（指数バックオフで自動再接続）／iPhone向け
    ble-client.js    Bluetooth(BLE/Web Bluetooth)接続／Android向け
    recorder.js      生フレームをIndexedDBに収録（再生用）
    app.js           配線：WS→行バッファ→収録→パース→集約→3ビュー
    views/
      fix-status.js   測位品質・DOP・座標・有効測位率
      sky-plot.js     極座標の衛星配置（使用/可視、SNRで大きさ）
      snr-chart.js    衛星ごとのC/N0棒グラフ
      timeseries.js   時系列グラフ（使用衛星数/HDOP/平均SNR・uPlot）FR-7
      data-quality.js データ品質（通過率・更新レート・間隔ジッタ・欠損率）FR-10
    dev/
      mock-feeder.js  開発用デモ生成器（Picoなしで動作確認）
```

時系列グラフ（FR-7）は uPlot を CDN から読み込みます（`index.html` の `<head>`）。
データ品質（FR-10）はチェックサム通過率・センテンス種別ごとの更新レート・
エポック間隔のジッタ（ヒストグラム）・GGA 欠損率を集計します。いずれも既存の
`EpochAssembler.onEpoch` が渡す Epoch をそのまま入力にしています。

データの流れ：`WS受信 → 行バッファ → 収録 → パース＋検証 → エポック確定 → 3ビュー更新`。

## ローカルで動かす

ES モジュールを使うので `file://` 直開きでは動きません。HTTP で配信してください。

```
cd gnss-monitor
python3 -m http.server 8000
# ブラウザで http://localhost:8000
```

「デモ再生」を押すと Pico なしでも動作確認できます（箕面付近の座標で合成 NMEA を 1Hz 生成）。

## Pico に繋ぐ（WebSocket / Bluetooth の選択式）

Pico W 側 `micropython/main.py` は、生 NMEA を **WebSocket と Bluetooth(BLE) の両方**で
同時配信します。受信側は上部の「接続方式」セレクタで選びます（端末に応じて自動で初期選択）。

| 端末 | 方式 | 理由 |
|---|---|---|
| iPhone / iPad | **WebSocket** | iOS は Web Bluetooth 非対応のため |
| Android | **Bluetooth(BLE)** | Web Bluetooth 対応。HTTPS ページからも接続でき、IP 入力も不要 |

### WebSocket（iPhone）
1. セレクタで「WebSocket」を選ぶ。
2. 入力欄に `ws://<PicoのIP>:<ポート>`（既定 `ws://picow.local/`）を入れて「接続」。
3. 切断されても自動で再接続します（接続状態は右上に表示）。

### Bluetooth（Android）
1. セレクタで「Bluetooth」を選ぶ（URL 欄は不要なので隠れます）。
2. 「接続」を押すとデバイス選択ダイアログが出るので `picow` を選ぶ。
3. 以後の切断は自動再接続（既知デバイスなので再選択は不要）。
4. **HTTPS ページ（Vercel 等）からそのまま接続できます**（下記の ws:// 制約を受けません）。
   Bluetooth は NMEA を Nordic UART Service(NUS) で notify 配信します
   （UUID は `js/ble-client.js` と `main.py` で一致）。
   BLE は WiFi に依存しないため、Pico が WiFi 圏外でも Android は接続可能です。

### 重要：HTTPS と ws:// の組み合わせは不可（WebSocket のみの制約）

HTTPS のページ（Vercel 等）からは `ws://`（非暗号化）に接続できません（mixed content で
ブラウザが遮断）。iPhone で現場ライブ取り込みするときは、この画面を `http://localhost` か
LAN 内の HTTP サーバから開いて `ws://<PicoのIP>` に繋いでください。
Android は Bluetooth を使えば HTTPS 本番ページのままライブ取り込みできます。

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
