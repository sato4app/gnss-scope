# gnss-scope

MAX-M10SからRaspberry Pi Picoに送られたNMEAデータを、
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

## 2系統の呼び方

受信機は入れ替える可能性があるため、**画面と出力に機種名は出さない**。次の2語だけを使う。

| 系統 | 表示名 | 実体 |
|---|---|---|
| 外部受信機 | **GNSS受信機** | BLE で生 NMEA を送ってくる機器（現状は MAX-M10S + Pico W） |
| 端末側 | **Android内蔵** | 端末自身の測位（Geolocation API / Fused Location） |

表示名の実体は `js/constants.js` の `SERIES` が唯一の出所。機種を替えるときはここだけ直す。
「NMEA」はデータ形式の名前であって系統名ではない（「生NMEA」等はそのまま使う）。

## 画面構成（タブ）

| タブ | 内容 |
|---|---|
| **接続** | connect / disconnect、接続状態、受信品質統計（受信機→Pico→BLE→アプリの取りこぼし確認） |
| **記録** | record / stop / save / 破棄、収束の進捗バー、現在の測位値、散布図と2系統の凡例、測位結果、地点の写真 |
| **一覧** | 端末内の測位データを日ごとに一覧（調査日 → 地点）。読込 / 詳細 / 編集 / **出力（ZIP 1ファイル）** / 削除・取込・容量警告 |
| **解析** | SkyPlot / SNR / DOP / DRMS。データソースを「ライブ」「読込データ」で切替 |
| **地図** | 地理院地図（標準/淡色/写真）。**load した記録の GNSS 値**を中心マーカー＋エポック点群＋DRMS 円で表示。ライブ受信中は現在地・精度円・軌跡も表示 |
| **設定** | UERE、記録の収集条件（自動停止・ビープ・最低/上限時間・上限エポック）、地図種別、オフラインタイル事前DL、アプリ更新確認、モックNMEA配信 |

## 記録の流れ（record → stop → save → load）

1. **record** — 下書きを作ってから、静止点に留まって連続エポックを収集する（Wake Lock で画面を維持）。
   **収集中も 5 エポック（≒5 秒）ごとに下書きへ追記する**ので、保存を押す前にアプリが
   終了しても直前までは残る。
2. **stop** — 収集を止めて集計（中心・標準偏差・DRMS / 2DRMS・CEP50 / CEP95・標高・fix内訳・平均DOP・平均C/N0）。
   集計値も下書きへ書くが、**この時点ではまだ「地点」ではない**。
   設定で「収束で自動停止」が有効なら、最低収集時間の経過後に**中心・DRMS が10秒横ばい**になった時点で自動停止する。
   自動停止は**ビープ音**で知らせる（収束＝短く2回 / 打ち切り＝長く1回。手動停止では鳴らさない）。
3. **save** — 地点名（既定 `yyyy-mm-dd-xx` の同日連番）とメモを付けて**確定**する。
   **このとき初めて地点番号を採番する**（下書きは番号を消費しないので、失敗記録を捨てても番号が飛ばない）。
   確定した記録はそのまま読込データになる。下書きは一覧タブの先頭に出て、再起動後もそこから確定できる。
4. **load** — 一覧タブの「読込」で保存済みの記録を、「📂 読込」で他端末が出力した ZIP / JSON を読み込む。
   取込は**調査日＋記録開始時刻**で照合し、すでに持っている地点は飛ばす（端末内に重複を作らない）。
   読み込んだ記録は解析タブ（スライダで任意エポックを再現）と地図タブに反映される。

記録時は**各エポックの衛星リスト（系統 / PRN / 仰角 / 方位 / C/N0 / 使用中）も保存**するため、
保存後・取込後でもスカイプロットと SNR チャートを再現できる。

地点には**現地の写真**を付けられる（既定 5 枚まで）。撮った写真は取り込む時点で
長辺 1280px・1枚 200KB 前後に縮めてから保存する。地点名・メモ・写真は一覧タブの「編集」で後から直せる。

記録データと写真は端末内に貯まり続けるため、**量を自分で数えて警告する**
（想定上限 100MB、50MB 超で一覧タブに警告。記録は止めない）。
warning には未書き出しぶんも併記するので、WiFi のある場所で一覧タブから調査日ごとに
**📦 出力**（ZIP 1ファイル）を書き出し、書き出し済みの調査日を削除して減らす。
削除は「地点ごと → 日ごと（一覧タブ）→ 全消去（設定タブ）」の3段。全消去は失うものを
数えて見せ、未書き出しがあるときだけ二度確認する。

**記録には記録専用の端末を使う。** 最後のエポックから 10 秒が過ぎると**打ち切る**
（画面 OFF・他アプリへの切替・BLE 切断・受信機の電池切れ・fix 喪失を一様に拾う。
データが届かないまま続けると、穴の空いた区間が1地点として残るため）。
復帰後は続きではなく別の地点として測り直す。地図や写真は別のスマートフォンで見る。

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

ドキュメントの PDF（`docs/*.pdf`）は VSCode 拡張「Markdown PDF」で作れるほか、
同じ体裁のままコマンドラインでも一括で出し直せる（拡張の CSS と既定設定を借りている）。
**変換スクリプトはこのリポジトリには入れず、全プロジェクト共通で `~/.claude/tools/md-to-pdf.mjs`
に1本だけ置いてある**（コピーを配ると直したときに配り直しになるため）：

```bash
node ~/.claude/tools/md-to-pdf.mjs          # docs/*.md をすべて変換
node ~/.claude/tools/md-to-pdf.mjs docs/funcspec-202607.md   # 変更したものだけ
node ~/.claude/tools/md-to-pdf.mjs --stale  # pdf より md が新しいものだけ
node ~/.claude/tools/md-to-pdf.mjs --check  # 拡張・Chrome・依存の解決結果（不調時の切り分け用）
```

Claude Code の Stop フック（`~/.claude/settings.json`）から `--hook`（= `--stale` ＋ JSON 出力）が
自動で呼ばれるため、md を直したあとの PDF 出し直しは手作業では不要。
対象が無ければ Chrome を起動せず 0.3 秒で終わるので、docs を触らなかった回のコストはほぼゼロ。
`docs/` を持つプロジェクトなら**セットアップなしでそのまま効く**（対象は実行時のカレント直下の `docs/`）。

拡張のディレクトリは**版数を決め打ちせず**、インストール済みの中から最新版を探す
（拡張が更新されてもパスを直す必要がない）。拡張・Chrome・依存のいずれかが欠けた場合は
理由を画面に出す。フックは stderr を捨てて exit を 0 に潰すため、黙って PDF が古いままに
ならないよう、失敗も `systemMessage` として必ず表示する。
場所を明示したいときは環境変数 `MDPDF_EXT_DIR` / `MDPDF_CHROME` を使う。

## ファイル構成

機能ごとに1ファイルへまとめ、UI（DOM 操作）とロジック（純粋関数・データ層）を分けている。

```
index.html / manifest.json / sw.js     アプリシェル・PWA・Service Worker
css/style.css                          ダークUI（ステータスバー / ページ / タブバー）
js/
  app.js             エントリ：受信パイプラインと各タブの結線
  constants.js       設定の既定値と2系統の表示名・色（永続化しないため、ここが唯一の出所）
  view-utils.js      画面共通（DOM ショートハンド・タブ切替・表示フォーマッタ・測位結果テキスト）
  ── 受信 ──
  transport.js       受信経路：BLE(NUS) 接続・自動再接続 ＋ 開発用モック配信
  nmea.js            行復元（LineBuffer）→ NMEA 解析 → エポック確定（EpochAssembler）
  stream-stats.js    受信品質統計（取りこぼしの確認）
  ── 解析・記録 ──
  accuracy.js        水平精度推定・DRMS/CEP 集計・収束判定
  charts.js          Canvas 描画（スカイプロット / SNR / 散布図）＋共通土台
  recorder.js        record / stop / save の制御
  device-gnss.js     Android内蔵GNSS の並行取得（記録中のみ）
  beep.js            自動停止の通知音（収束＝短く2回 / 上限＝長く1回）
  storage.js         IndexedDB ラッパ（gnssScopeDB）
  survey.js          調査日→地点のID体系・測定区間・対応検証
  file-io.js         CSV / GPX / NMEA / JSON の組み立てと JSON 取込
  zip.js             ZIP の読み書き（自前実装。CRC-32・deflate/store）
  package-io.js      出力ZIP（manifest 組み立て・詰め込み・取込）
  ── 画面（タブごと） ──
  connect-ui.js      接続タブ（connect / disconnect / 受信品質 / モック切替）
  record-ui.js       記録タブ（record / stop / save・進捗バー・凡例・現在の測位値・Wake Lock）
  list-ui.js         一覧タブ（調査日ツリー・編集・出力・取込・容量警告）
  photo-ui.js        地点の写真（縮小・JPEG 圧縮 ＋ 追加/削除/サムネイル）
  analysis-ui.js     解析タブ（SkyPlot / SNR / DOP / DRMS、ライブ↔読込切替）
  map.js             地図タブ（Leaflet ＋ 地理院地図・読込データ表示）＋ オフラインタイル事前DL
  settings-ui.js     設定タブ（各種設定・アプリ更新確認）
data/                                  タイルマニフェスト・GeoJSON
vendor/leaflet/                        Leaflet（オフライン用にローカル配置）
micropython/main.py                    Pico W 側ファーム（ダムパイプ）
tools/check-syntax.mjs                 構文チェック＋純粋ロジックテスト
```

**このリポジトリは npm 依存を持たない**（`package.json` も `node_modules` も無い）。
アプリ本体はビルド不要の静的ファイル構成で、PDF 変換に必要な markdown-it / highlight.js は
リポジトリの外（`~/.claude/tools/`）に置いてある。

## ドキュメント

| 文書 | 内容 | 主な読者 |
|---|---|---|
| [docs/funcspec-202607.md](docs/funcspec-202607.md) | **機能仕様**（何ができるか・仕様値・画面ごとの定義） | 仕様を確認する人 |
| [docs/usersGuide-202607.md](docs/usersGuide-202607.md) | **利用者の手引**（操作手順・画面の読み方・困ったとき） | 使う人 |
| [docs/design-202607.md](docs/design-202607.md) | **実装設計**（構成・データモデル・モジュール責務・リファクタ記録） | 実装する人 |
| [docs/algospec-202607.md](docs/algospec-202607.md) | **算出・判定ロジック**（精度推定・DRMS/CEP・収束自動停止・表示保持・受信品質・散布図の表示半径） | 数値の根拠を追う人 |
| [docs/hardware-202607.md](docs/hardware-202607.md) | **機器・ファーム仕様**（MAX-M10S / Pico W / UART / BLE / `$PPICO`） | 機器を組む人 |

この5文書が現行の仕様です（前身 gnss-tracker 時代の要件・設計、および個別機能ごとの実装仕様書は、
内容を上記へ統合したうえで削除しました）。

| 解説 | 内容 | 主な読者 |
|---|---|---|
| [docs/record-202607.md](docs/record-202607.md) | **記録タブ機能まとめ**（record → stop → save → load の流れを1枚に） | 記録機能を把握したい人 |
| [docs/list-202607.md](docs/list-202607.md) | **一覧タブ機能まとめ**（日ごとの一覧・出力ZIP の構造・取込） | 出力データを扱う人 |

解説は上記5文書から派生したもので、仕様の正本ではありません。
