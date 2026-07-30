# gnss-scope

MAX-M10SからRaspberry Pi Picoに送られたNMEAでーたを、
bluetooth経由でスマホ(Android)に受信し、記録する。
受信したNMEAデータは、indexeddbに保存する。
NMEAデータからSkyPlot, SNR, DOP, DRMSを解析・表示する。
地理院地図にもマーカーとして表示可能とする。

```
[u-blox MAX-M10S] --UART(38400)--> [Raspberry Pi Pico W] --BLE(NUS notify)--> [Android Chrome / 本PWA]
```

前身の `gnss-tracker`（地理院地図の表示がメイン）から再構築したもので、
**地図は主役ではなく1タブ**に位置付けを変え、記録と解析を中心にしています。

- Pico W 側（`micropython/main.py`）は NMEA を一切パースしない「ダムパイプ」。解析はすべてアプリ側。
- 接続は **BLE（Web Bluetooth）専用**。iPhone / iPad は Web Bluetooth 非対応のため対象外（Android Chrome 前提）。
- データは **端末内の IndexedDB のみ**に保存（外部送信なし）。オフラインで完結する PWA。

## 画面構成（タブ）

| タブ | 内容 |
|---|---|
| **接続** | connect / disconnect、接続状態、受信品質統計（M10S→Pico→BLE→アプリの取りこぼし確認） |
| **記録** | record / stop / save / load、現在の測位値、収集状況、散布図、記録一覧（CSV/GPX/JSON 出力・削除・JSON 取込） |
| **解析** | SkyPlot / SNR / DOP / DRMS。データソースを「ライブ」「読込データ」で切替 |
| **地図** | 地理院地図（標準/淡色/写真）。**load した記録の GNSS 値**を中心マーカー＋エポック点群＋DRMS 円で表示。ライブ受信中は現在地・精度円・軌跡も表示 |
| **設定** | UERE、記録の収集条件（自動停止・最低/上限時間・上限エポック）、地図種別、オフラインタイル事前DL、アプリ更新確認、モックNMEA配信 |

## 記録の流れ（record → stop → save → load）

1. **record** — 静止点に留まって連続エポックを収集する（Wake Lock で画面を維持）。
2. **stop** — 収集を止めて集計（中心・標準偏差・DRMS / 2DRMS・CEP50 / CEP95・標高・fix内訳・平均DOP・平均C/N0）。
   この時点では **まだ保存されない**（未保存の記録）。
   設定で「収束で自動停止」が有効なら、最低収集時間の経過後に**中心・DRMS が10秒横ばい**になった時点で自動停止する。
3. **save** — 地点名（既定 `yyyy-mm-dd-xx` の同日連番）とメモを付けて IndexedDB へ保存し、そのまま読込データになる。
4. **load** — 記録一覧の「読込」で保存済みの記録を、「📂 JSON取込」で他端末が出力した JSON を読み込む。
   読み込んだ記録は解析タブ（スライダで任意エポックを再現）と地図タブに反映される。

記録時は**各エポックの衛星リスト（系統 / PRN / 仰角 / 方位 / C/N0 / 使用中）も保存**するため、
保存後・取込後でもスカイプロットと SNR チャートを再現できる。

## 開発・実行

ES モジュール構成のため、ローカルサーバーが必要（`file://` では動かない）。
Web Bluetooth は **HTTPS または localhost** のみで動作する。

```bash
python -m http.server 8000
# または npx serve .
# ブラウザで http://localhost:8000 を開く
```

実機がない場合は、設定タブの「モックNMEA配信」で 5 系統フル GSV の擬似 NMEA を流せる。

構文チェックと純粋ロジックのテスト：

```bash
node tools/check-syntax.mjs
```

## ファイル構成

機能ごとに1ファイルへまとめ、UI（DOM 操作）とロジック（純粋関数・データ層）を分けている。

```
index.html / manifest.json / sw.js     アプリシェル・PWA・Service Worker
css/style.css                          ダークUI（ステータスバー / ページ / タブバー）
js/
  app.js             エントリ：受信パイプラインと各タブの結線のみ
  view-utils.js      画面共通（DOM ショートハンド・タブ切替・表示フォーマッタ）
  ── 受信 ──
  transport.js       受信経路：BLE(NUS) 接続・自動再接続 ＋ 開発用モック配信
  nmea.js            行復元（LineBuffer）＋ NMEA 解析（GGA/RMC/GSA/GSV/VTG/GST/$PPICO）
  epoch.js           同一時刻センテンス群 → 1エポック
  stream-stats.js    受信品質統計（取りこぼしの確認）
  ── 解析・記録 ──
  accuracy.js        水平精度推定・DRMS/CEP 集計・収束判定
  charts.js          Canvas 描画（スカイプロット / SNR / 散布図）＋共通土台
  recorder.js        record / stop / save の制御
  storage.js         IndexedDB ラッパ（gnssScopeDB）
  file-io.js         CSV / GPX / JSON 出力と JSON 取込
  ── 画面（タブごと） ──
  connect-ui.js      接続タブ（connect / disconnect / 受信品質 / モック切替）
  record-ui.js       記録タブ（record / stop / save / load・一覧・Wake Lock）
  analysis-ui.js     解析タブ（SkyPlot / SNR / DOP / DRMS、ライブ↔読込切替）
  map.js             地図タブ（Leaflet ＋ 地理院地図・読込データ表示）
  settings-ui.js     設定タブ（各種設定・アプリ更新確認）
  tile-cache.js      オフラインタイル事前ダウンロード（設定タブ内）
data/                                  タイルマニフェスト・GeoJSON
vendor/leaflet/                        Leaflet（オフライン用にローカル配置）
micropython/main.py                    Pico W 側ファーム（ダムパイプ）
tools/check-syntax.mjs                 構文チェック＋純粋ロジックテスト
```

## ドキュメント

| 文書 | 内容 | 主な読者 |
|---|---|---|
| [docs/funcspec-202607.md](docs/funcspec-202607.md) | **機能仕様**（何ができるか・仕様値・画面ごとの定義） | 仕様を確認する人 |
| [docs/usersGuide-202607.md](docs/usersGuide-202607.md) | **利用者の手引**（操作手順・画面の読み方・困ったとき） | 使う人 |
| [docs/design-202607.md](docs/design-202607.md) | **実装設計**（構成・データモデル・モジュール責務・リファクタ記録） | 実装する人 |
| [docs/algospec-202607.md](docs/algospec-202607.md) | **算出・判定ロジック**（精度推定・DRMS/CEP・収束自動停止・表示保持・受信品質） | 数値の根拠を追う人 |
| [docs/hardware-202607.md](docs/hardware-202607.md) | **機器・ファーム仕様**（MAX-M10S / Pico W / UART / BLE / `$PPICO`） | 機器を組む人 |

この5文書が現行の仕様です（前身 gnss-tracker 時代の要件・設計、および個別機能ごとの実装仕様書は、
内容を上記へ統合したうえで削除しました）。
