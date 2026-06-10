# main.py  (step2: 生NMEA を WebSocket と Bluetooth(BLE) の両方で配信 / Pico W "ダムパイプ")
# =============================================================================
# 設計方針:
#   - Picoは生のNMEA文を一切パースせず、そのまま全種類を流すだけ。
#     （$GNRMC, $GNGGA, $GNGSV ... 何が欲しくなってもファームは変更不要）
#   - パース・判定・地図表示はすべて受信側(PC/スマホブラウザ)で行う。
#   - 接続方式は受信側で選択する：
#       * iPhone  → WebSocket（ws://picow.local/）          ※iOSはWeb Bluetooth非対応
#       * Android → Bluetooth(BLE, Nordic UART Service)      ※Web Bluetoothで接続
#     どちらも同じ生NMEAが流れるので、受信側の後段処理は共通。
#   - 屋外無人運用向けに堅牢化: WiFi自動再接続 / ソケット再待受 /
#     ウォッチドッグ / gc.collect。
#   - BLE は WiFi に依存しない。WiFi 未接続でも BLE は常時広告し続けるので、
#     Android はネットワーク無しでも接続できる（iPhone の WS だけ不可）。
#
# 接続先(SSID/パス)は config.py の WIFI_NETWORKS（上から優先）。
# =============================================================================

import network
import machine
import time
import socket
import select
import gc
import hashlib
import binascii
from machine import UART, Pin, WDT

# BLE 非対応ファームでも WS だけは動くよう、import を保護する。
try:
    import bluetooth
    _BLE_OK = True
except ImportError:
    _BLE_OK = False
    print("！ bluetooth モジュール無し（BLE非対応ファーム）。WSのみで稼働")

try:
    from config import WIFI_NETWORKS
except ImportError:
    WIFI_NETWORKS = []
    print("！ config.py が無い／WIFI_NETWORKS 未定義（BLEのみで稼働）")

# ── 設定（ハードウェアに合わせた固定値。基本変更不要） ──────────────────
HOSTNAME   = "picow"        # mDNS: picow.local / BLE広告名にも使用
WS_PORT    = 80             # ws://picow.local/ （80なのでポート指定不要）
UART_ID    = 0
UART_TX    = 0              # GP0 → M10S RX
UART_RX    = 1              # GP1 ← M10S TX
UART_BAUD  = 9600           # Switch Science MAX-M10S は 9600
WDT_TIMEOUT_MS = 8000       # RP2040 の上限付近
SEND_TIMEOUT   = 1.0        # 1フレーム送信の上限秒。超えたらそのクライアントを切断
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

led = Pin("LED", Pin.OUT)


def blink(times, on_ms=80, off_ms=80):
    for _ in range(times):
        led.on();  time.sleep_ms(on_ms)
        led.off(); time.sleep_ms(off_ms)


# =============================================================================
# Bluetooth(BLE) ：Nordic UART Service(NUS) で生NMEAを notify 配信する周辺機器
# =============================================================================
# Web Bluetooth(Android Chrome 等)が接続する標準的な「シリアルover BLE」。
# 受信側 js/ble-client.js の UUID と必ず一致させること。
_IRQ_CENTRAL_CONNECT    = 1
_IRQ_CENTRAL_DISCONNECT = 2
_IRQ_MTU_EXCHANGED      = 21

# NUS の UUID 文字列（bluetooth.UUID 化は BlePeripheral.__init__ 内で行う。
# BLE 非対応ファームでも本モジュールが読み込めるよう、ここでは文字列のみ持つ）
_NUS_UUID_STR = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
_NUS_TX_STR   = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  # 周辺→中央（notify）
_NUS_RX_STR   = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  # 中央→周辺（write, 未使用）


def _adv_payload(name=None, services=None):
    # BLE 広告ペイロード（31バイト上限）を組み立てる。
    payload = bytearray()

    def _append(adv_type, value):
        payload.extend(bytes((len(value) + 1, adv_type)))
        payload.extend(value)

    _append(0x01, b"\x06")  # Flags: LE General Discoverable, BR/EDR非対応
    if name:
        _append(0x09, name.encode())     # Complete Local Name
    if services:
        for uuid in services:
            b = bytes(uuid)
            _append(0x07 if len(b) == 16 else 0x03, b)  # 128bit / 16bit UUID
    return payload


class BlePeripheral:
    def __init__(self, name="picow"):
        nus_uuid = bluetooth.UUID(_NUS_UUID_STR)
        nus_tx = (bluetooth.UUID(_NUS_TX_STR), bluetooth.FLAG_NOTIFY,)
        nus_rx = (bluetooth.UUID(_NUS_RX_STR), bluetooth.FLAG_WRITE,)
        nus_service = (nus_uuid, (nus_tx, nus_rx,),)

        self._ble = bluetooth.BLE()
        self._ble.active(True)
        self._ble.irq(self._irq)
        ((self._tx_handle, self._rx_handle),) = self._ble.gatts_register_services((nus_service,))
        # conn_handle -> notify 1回あたりの最大ペイロード長（ATT_MTU-3）
        self._conns = {}
        self._payload = _adv_payload(name=name, services=[nus_uuid])
        self._advertise()

    def _irq(self, event, data):
        if event == _IRQ_CENTRAL_CONNECT:
            conn_handle, _, _ = data
            self._conns[conn_handle] = 20        # 既定 ATT_MTU=23 → ペイロード20
            print("  BLE接続: handle", conn_handle, "（現在", len(self._conns), "台）")
        elif event == _IRQ_CENTRAL_DISCONNECT:
            conn_handle, _, _ = data
            self._conns.pop(conn_handle, None)
            print("  BLE切断: handle", conn_handle)
            self._advertise()                    # 次の端末を受け付ける
        elif event == _IRQ_MTU_EXCHANGED:
            conn_handle, mtu = data
            self._conns[conn_handle] = max(20, mtu - 3)

    def _advertise(self, interval_us=200000):
        try:
            self._ble.gap_advertise(interval_us, adv_data=self._payload)
        except Exception as e:
            print("  BLE広告エラー:", e)

    def send_line(self, line):
        # line: bytes（改行なし）。受信側で行に再分割できるよう \n を付け、
        # ATT_MTU に収まるサイズに分割して notify する。
        if not self._conns:
            return
        data = line + b"\n"
        n = len(data)
        for conn, chunk_len in list(self._conns.items()):
            mv = memoryview(data)
            i = 0
            while i < n:
                chunk = mv[i:i + chunk_len]
                # 送信バッファが一時的に詰まると OSError。少し待って数回リトライする。
                # （ここで接続を切らない＝Androidの頻繁な切断を防ぐ）
                sent = False
                for _ in range(10):
                    try:
                        self._ble.gatts_notify(conn, self._tx_handle, chunk)
                        sent = True
                        break
                    except OSError:
                        time.sleep_ms(5)
                if not sent:
                    # この行は諦めて次のクライアントへ（接続は維持。
                    # 途切れた行は受信側のチェックサム検証で弾かれる）
                    break
                i += chunk_len

    def count(self):
        return len(self._conns)


# ── WiFi接続（WDTがあれば待ち時間中も feed して誤リセットを防ぐ） ────────
def connect_wifi(wlan, networks, wdt=None):
    for ssid, pw in networks:
        try:
            wlan.disconnect()
        except Exception:
            pass
        print("WiFi接続を試行:", ssid)
        wlan.connect(ssid, pw)
        for _ in range(40):                  # 最大 ~20秒
            if wlan.isconnected():
                print("  ✓ 接続:", ssid, wlan.ifconfig()[0])
                return True
            if wdt:
                wdt.feed()
            led.on();  time.sleep_ms(250)
            led.off(); time.sleep_ms(250)
    return False


# ── WebSocket ハンドシェイク応答キー ────────────────────────────────────
def ws_accept_key(client_key):
    h = hashlib.sha1(client_key.encode() + WS_GUID)
    return binascii.b2a_base64(h.digest()).strip().decode()


# ── サーバ→クライアントの textフレーム（マスクなし） ─────────────────────
def ws_frame(payload):
    n = len(payload)
    if n < 126:
        head = bytes([0x81, n])
    elif n < 65536:
        head = bytes([0x81, 126, (n >> 8) & 0xff, n & 0xff])
    else:
        head = bytes([0x81, 127]) + n.to_bytes(8, "big")
    return head + payload


# ── データを「全部送り切る」。送り切れなければ例外 → 呼び出し側で切断 ───
# （ノンブロッキングsendの途中切れによるWSフレーム破損を防ぐのが目的）
def send_all(cl, data):
    mv = memoryview(data)
    total = len(data)
    sent = 0
    while sent < total:
        n = cl.send(mv[sent:])
        if not n:
            raise OSError("send 0")
        sent += n


# ── 受信したHTTPリクエストを処理。WS upgradeなら101、違えば状態ページ ───
def handle_new_connection(server, clients, poller, status):
    try:
        cl, remote = server.accept()
    except Exception:
        return
    try:
        cl.settimeout(3.0)
        req = cl.recv(1024)
        if not req:
            cl.close(); return
        text = req.decode("utf-8", "ignore")

        # Sec-WebSocket-Key を探す
        key = None
        for line in text.split("\r\n"):
            l = line.lower()
            if l.startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
                break

        if key and "upgrade" in text.lower():
            accept = ws_accept_key(key)
            resp = ("HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n")
            cl.settimeout(SEND_TIMEOUT)     # 送信は短時間で諦める（詰まり対策）
            send_all(cl, resp.encode())
            poller.register(cl, select.POLLIN)
            clients.append(cl)
            print("  WS接続:", remote[0], " (現在", len(clients), "台)")
        else:
            # 通常のGET → 動作確認用の簡単な状態ページ
            html = (
                "HTTP/1.0 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                "Connection: close\r\n\r\n"
                "<!DOCTYPE html><meta charset=utf-8>"
                "<body style='font-family:sans-serif;text-align:center;padding-top:40px'>"
                "<h2>Pico W NMEA bridge</h2>"
                "<p>WebSocket: ws://picow.local/</p>"
                "<p>Bluetooth(BLE): " + HOSTNAME + " （Androidで接続）</p>"
                "<p>接続中WSクライアント: " + str(len(clients)) + " 台</p>"
                "<p>" + status + "</p></body>")
            cl.send(html.encode())
            cl.close()
    except Exception as e:
        print("  接続処理エラー:", e)
        try:
            cl.close()
        except Exception:
            pass


def drop_client(cl, clients, poller):
    try:
        poller.unregister(cl)
    except Exception:
        pass
    try:
        cl.close()
    except Exception:
        pass
    if cl in clients:
        clients.remove(cl)


def build_server(poller):
    addr = socket.getaddrinfo("0.0.0.0", WS_PORT)[0][-1]
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(addr)
    s.listen(2)
    poller.register(s, select.POLLIN)
    return s


# ============================ メイン ============================
def main():
    # UART（GNSS）
    uart = UART(UART_ID, baudrate=UART_BAUD, tx=Pin(UART_TX), rx=Pin(UART_RX))

    # Bluetooth(BLE) は WiFi に依存しないので先に起動し、常時広告する。
    # （Android はネットワーク無しでも、この時点からすぐ接続できる）
    ble = None
    if _BLE_OK:
        try:
            ble = BlePeripheral(name=HOSTNAME)
            print("✓ Bluetooth: BLE(NUS) 広告開始  name=%s" % HOSTNAME)
        except Exception as e:
            print("✗ Bluetooth 初期化失敗（WSのみで継続）:", e)

    # WiFi（iPhone 用 WebSocket）。失敗しても BLE で動き続ける。
    wlan = network.WLAN(network.STA_IF)
    try:
        network.hostname(HOSTNAME)        # mDNS用に接続前設定
    except Exception:
        pass
    wlan.active(True)

    wifi_ok = bool(WIFI_NETWORKS) and connect_wifi(wlan, WIFI_NETWORKS)
    print("=" * 48)
    if wifi_ok:
        ip = wlan.ifconfig()[0]
        print("✓ WiFi:", wlan.config("ssid"), ip)
        print("  WebSocket : ws://picow.local/   (または ws://%s/)" % ip)
    else:
        print("✗ WiFi未接続。BLEのみで稼働（iPhoneのWSは不可）。後で自動再試行。")
    print("  Bluetooth : %s （Android で接続）" % HOSTNAME)
    print("=" * 48)
    led.on()

    # 初回接続が済んでからWDT起動（初回接続の待ち時間で誤リセットしない）
    wdt = WDT(timeout=WDT_TIMEOUT_MS)

    poller = select.poll()
    server = build_server(poller) if wifi_ok else None
    clients = []

    buf = b""
    last_wifi_check = time.ticks_ms()
    last_gc = time.ticks_ms()

    while True:
        wdt.feed()

        # 1) WS ソケットのイベント処理（サーバがある時だけ）
        if server is not None:
            try:
                events = poller.poll(0)
            except Exception:
                events = []
            for obj, ev in events:
                if obj is server:
                    handle_new_connection(server, clients, poller,
                                          "fix判定は受信側で")
                else:
                    # クライアントから何か来た or 切断/エラー
                    if ev & (select.POLLHUP | select.POLLERR):
                        drop_client(obj, clients, poller)
                        continue
                    try:
                        d = obj.recv(64)
                        if not d:                         # TCP切断
                            drop_client(obj, clients, poller)
                        elif d[0] & 0x0f == 0x8:           # WS closeフレーム
                            drop_client(obj, clients, poller)
                        # それ以外(ping等)は無視
                    except Exception:
                        drop_client(obj, clients, poller)

        # 2) GNSSのNMEAを読み、行単位で WS と BLE の両方へ配信（無加工）
        try:
            if uart.any():
                buf += uart.read()
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()                   # \r や空白を除去
                if not line:
                    continue
                if clients:                           # WebSocket（iPhone）へ
                    frame = ws_frame(line)
                    for cl in list(clients):
                        try:
                            send_all(cl, frame)
                        except Exception:
                            drop_client(cl, clients, poller)
                if ble is not None:                   # Bluetooth（Android）へ
                    ble.send_line(line)
            if len(buf) > 2048:                       # 暴走防止
                buf = b""
        except Exception as e:
            print("UART/送信エラー:", e)

        # 3) 定期: WiFi断の自動再接続（未接続でも再試行し、復帰でサーバ再構築）
        #    再試行(connect_wifi)は最大~20秒ブロックし BLE 配信が一時的に途切れる。
        #    BLE運用のみのときに毎回スキャンして途切れないよう、未接続時は間隔を空ける。
        wifi_gap = 5000 if wlan.isconnected() else 30000
        if time.ticks_diff(time.ticks_ms(), last_wifi_check) > wifi_gap:
            last_wifi_check = time.ticks_ms()
            if WIFI_NETWORKS and not wlan.isconnected():
                print("WiFi未接続 → 再接続を試行")
                for cl in list(clients):
                    drop_client(cl, clients, poller)
                if server is not None:
                    try:
                        poller.unregister(server); server.close()
                    except Exception:
                        pass
                    server = None
                if connect_wifi(wlan, WIFI_NETWORKS, wdt):
                    server = build_server(poller)
                    led.on()
                    print("  WiFi再接続OK:", wlan.ifconfig()[0])

        # 4) 定期: メモリ回収（ソケット枠の解放。step0で学んだ対策）
        if time.ticks_diff(time.ticks_ms(), last_gc) > 2000:
            last_gc = time.ticks_ms()
            gc.collect()

        time.sleep_ms(10)


main()
