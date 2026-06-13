# GNSS Scope (M10S / NMEA over Bluetooth LE)

PicoW + MAX-M10S が Bluetooth(BLE) で流す生 NMEA を受け、Fix 状態・スカイプロット・SNR を
リアルタイム表示する Vanilla JS（ES モジュール）の受信基盤＋ライブ表示。
受信側は Web Bluetooth 対応端末（Android の Chrome/Edge 等）が必須。

## 構成

```
gnss-monitor/
  index.html
  manifest.webmanifest  PWAマニフェスト（ホーム画面追加用）
  service-worker.js     オフラインキャッシュ（stale-while-revalidate）
  icons/                PWAアイコン
  vendor/uplot/         uPlot（ローカル同梱。オフラインでも時系列が動く）
  css/style.css
  js/
    nmea.js          NMEAパーサ（GGA/RMC/GSA/GSV）＋チェックサム
    line-buffer.js   受信フレームを改行で行に再分割（断片結合）
    epoch.js         同一時刻のセンテンスを1エポックに集約
    ble-client.js    Bluetooth(BLE/Web Bluetooth)接続（自動再接続つき）
    recorder.js      生フレームをIndexedDBに収録（再生用）
    app.js           配線：BLE→行バッファ→収録→パース→集約→3ビュー
    views/
      view-utils.js   ビュー共通処理（DPR対応キャンバス・使用衛星PRNセット）
      fix-status.js   測位品質・DOP・座標・有効測位率
      sky-plot.js     極座標の衛星配置（使用/可視、SNRで大きさ）
      snr-chart.js    衛星ごとのC/N0棒グラフ
      timeseries.js   時系列グラフ（使用衛星数/HDOP/平均SNR・uPlot）FR-7
      data-quality.js データ品質（通過率・更新レート・間隔ジッタ・欠損率）FR-10
    dev/
      mock-feeder.js  開発用デモ生成器（Picoなしで動作確認）
```

時系列グラフ（FR-7）は uPlot を `vendor/uplot/` から読み込みます（`index.html` の `<head>`。
オフライン起動できるよう CDN ではなくローカル同梱）。
データ品質（FR-10）はチェックサム通過率・センテンス種別ごとの更新レート・
エポック間隔のジッタ（ヒストグラム）・GGA 欠損率を集計します。いずれも既存の
`EpochAssembler.onEpoch` が渡す Epoch をそのまま入力にしています。

データの流れ：`BLE受信 → 行バッファ → 収録 → パース＋検証 → エポック確定 → 3ビュー更新`。

## ローカルで動かす

ES モジュールを使うので `file://` 直開きでは動きません。HTTP で配信してください。

```
cd gnss-monitor
python3 -m http.server 8000
# ブラウザで http://localhost:8000
```

「デモ再生」を押すと Pico なしでも動作確認できます（箕面付近の座標で合成 NMEA を 1Hz 生成）。

## PWA（オフライン起動）

HTTPS（GitHub Pages 等）または `http://localhost` で一度開くと、Service Worker が
アプリ一式（uPlot 含む）をキャッシュします。以後は **配信サーバや電波の圏外でも起動可能**で、
Android は Chrome のメニューから「ホーム画面に追加」するとアプリとして全画面起動できます。
BLE 接続なら Pico と端末だけで完結するため、屋外でも PC は不要です。

- 更新の反映：オンラインで開くと裏で最新版を取り直し、**次回の表示**から反映されます
  （stale-while-revalidate）。
- キャッシュを確実に作り直したいときは `service-worker.js` の `CACHE_NAME` の版数を上げてください。

## Pico に繋ぐ（Bluetooth(BLE) 固定）

Pico W 側 `micropython/main.py` は、生 NMEA を **Bluetooth(BLE, Nordic UART Service)** で
配信します（WiFi/WebSocket は廃止。ルーター・PC・config.py は不要）。

1. HTTPS のページ（GitHub Pages 等）または `http://localhost` でこの画面を開く
   （Web Bluetooth はセキュアコンテキスト必須。`http://<IP>` では使えません）。
2. 「接続」を押すとデバイス選択ダイアログが出るので `picow` を選ぶ。
3. 以後の切断は自動再接続（既知デバイスなので再選択は不要）。

- NMEA は NUS の notify で配信されます（UUID は `js/ble-client.js` と `main.py` で一致）。
- iPhone/iPad は Web Bluetooth 非対応のため、本構成では接続できません（Android 必須）。

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
