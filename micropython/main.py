# main.py  (step3: 生NMEA を Bluetooth(BLE) のみで配信 / Pico W "ダムパイプ")
# =============================================================================
# 設計方針:
#   - Picoは生のNMEA文を一切パースせず、そのまま全種類を流すだけ。
#     （$GNRMC, $GNGGA, $GNGSV ... 何が欲しくなってもファームは変更不要）
#   - パース・判定・表示はすべて受信側(スマホブラウザ)で行う。
#   - 配信は Bluetooth(BLE, Nordic UART Service) のみ。WiFi/WebSocket は廃止した。
#     受信側は Web Bluetooth 対応端末（Android の Chrome/Edge 等）が必須。
#     （iPhone/iPad は Web Bluetooth 非対応のため対象外）
#   - ネットワーク不要：ルーター・PCが無い屋外でも Pico と Android だけで完結する。
#     config.py（WiFi の SSID/パスワード）も不要になった。
#   - 屋外無人運用向けに堅牢化: ウォッチドッグ / gc.collect / BLE自動再広告。
#   - GNSS の UART は起動時にボーレートを自動同期する：
#     まず 38400 で有効な NMEA が来るか確認 → 来なければ工場出荷時の 9600 で
#     開いて UBX-CFG-VALSET で 38400 へ切替 → 38400 で再確認。
#     （9600 ではマルチGNSSのフル出力(特にGSV)が帯域に収まらず間引かれるため）
# =============================================================================

import time
import gc
from machine import UART, Pin, WDT

# BLE専用構成のため bluetooth モジュールは必須。
# 非対応ファームの場合は main() 冒頭でLED点滅して知らせ続ける。
try:
    import bluetooth
    _BLE_OK = True
except ImportError:
    _BLE_OK = False

# ── 設定（ハードウェアに合わせた固定値。基本変更不要） ──────────────────
BLE_NAME   = "picow"        # BLE広告名（受信側 js/ble-client.js の namePrefix と一致）
UART_ID    = 0
UART_TX    = 0              # GP0 → M10S RX
UART_RX    = 1              # GP1 ← M10S TX
UART_BAUD         = 38400   # 目標ボーレート（起動時に M10S へ切替を指示する）
UART_BAUD_DEFAULT = 9600    # M10S の工場出荷時ボーレート（電源投入直後はこれ）
UART_RXBUF        = 4096    # 受信バッファ。BLE 送信のブロック中に溢れないよう拡大
WDT_TIMEOUT_MS = 8000       # RP2040 の上限付近

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

# NUS の UUID 文字列（bluetooth.UUID 化は BlePeripheral.__init__ 内で行う）
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


# ── GNSS UART のボーレート自動同期 ────────────────────────────────────────
# M10S は設定保存用フラッシュを持たず、電源投入のたびに 9600 で起動する。
# 一方ソフトリセット直後などは 38400 のまま動いていることもあるため、
# どちらの状態からでも自力で 38400 に揃うよう、起動時に検出＋切替を行う。

def _open_uart(baud):
    return UART(UART_ID, baudrate=baud, tx=Pin(UART_TX), rx=Pin(UART_RX),
                rxbuf=UART_RXBUF)


def _nmea_checksum_ok(line):
    # b"$....*hh" 形式の1行のチェックサムを検証（$ と * の間を XOR）
    star = line.rfind(b"*")
    if not line.startswith(b"$") or star < 1 or len(line) < star + 3:
        return False
    cs = 0
    for b in line[1:star]:
        cs ^= b
    try:
        return cs == int(line[star + 1:star + 3], 16)
    except ValueError:
        return False


def _valid_nmea_seen(uart, wait_ms=1500):
    # wait_ms 以内に正しいチェックサムの NMEA 行が1つでも来たら True。
    # ボーレート不一致時は文字化けバイトしか来ないので False になる。
    buf = b""
    deadline = time.ticks_add(time.ticks_ms(), wait_ms)
    while time.ticks_diff(deadline, time.ticks_ms()) > 0:
        d = uart.read() if uart.any() else None
        if d:
            buf += d
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if _nmea_checksum_ok(line.strip()):
                    return True
            if len(buf) > 512:        # 文字化けで改行が来ない場合の暴走防止
                buf = buf[-256:]
        time.sleep_ms(20)
    return False


def _ubx_valset_baud(baud):
    # UBX-CFG-VALSET で CFG-UART1-BAUDRATE(0x40520001) を RAM+BBR 層に設定する
    # フレームを組み立てる（チェックサムは 8bit Fletcher）。
    payload = (bytes([0x00, 0x03, 0x00, 0x00])          # version, layers(RAM|BBR), 予約
               + (0x40520001).to_bytes(4, "little")     # キー: CFG-UART1-BAUDRATE
               + baud.to_bytes(4, "little"))            # 値: ボーレート(U4)
    body = bytes([0x06, 0x8A]) + len(payload).to_bytes(2, "little") + payload
    ck_a = ck_b = 0
    for b in body:
        ck_a = (ck_a + b) & 0xFF
        ck_b = (ck_b + ck_a) & 0xFF
    return b"\xb5\x62" + body + bytes([ck_a, ck_b])


def init_gnss_uart():
    for attempt in range(3):
        # 1) 既に目標ボーレートで動いているか（ソフトリセット直後・切替済みの再確認）
        uart = _open_uart(UART_BAUD)
        if _valid_nmea_seen(uart):
            print("✓ GNSS: %d baud で受信中" % UART_BAUD)
            return uart
        uart.deinit()

        # 2) 工場出荷時ボーレートで受けられたら、目標ボーレートへの切替を指示
        uart = _open_uart(UART_BAUD_DEFAULT)
        if _valid_nmea_seen(uart):
            print("  GNSS: %d baud を検出 → %d baud へ切替指示" % (UART_BAUD_DEFAULT, UART_BAUD))
            uart.write(_ubx_valset_baud(UART_BAUD))
            time.sleep_ms(200)        # 送信完了とモジュール側の切替を待つ
        else:
            print("  GNSS: NMEA未検出 (試行 %d/3)" % (attempt + 1))
        uart.deinit()
        # 次のループ先頭で 38400 を再確認する（＝切替の検証を兼ねる）

    # 切替できず（GNSS未接続・故障等）：従来どおり 9600 で開いて継続する。
    # 後から 9600 のモジュールが繋がれば、少なくとも従来と同じ動作になる。
    print("！ GNSS: %d baud へ切替できず。%d baud で継続" % (UART_BAUD, UART_BAUD_DEFAULT))
    return _open_uart(UART_BAUD_DEFAULT)


# ============================ メイン ============================
def main():
    # BLE専用構成：bluetooth モジュールが無いファームでは動作できない。
    # LEDをゆっくり点滅させて知らせ続ける（WDT未起動なのでリセットはかからない）。
    if not _BLE_OK:
        print("✗ bluetooth モジュール無し（BLE非対応ファーム）。動作できません")
        while True:
            blink(1, on_ms=500, off_ms=500)

    # UART（GNSS）。ボーレートは自動同期（38400 へ引き上げ、失敗時 9600）
    uart = init_gnss_uart()

    # Bluetooth(BLE)。起動に失敗したら知らせ続ける（配信手段が他に無いため）
    try:
        ble = BlePeripheral(name=BLE_NAME)
    except Exception as e:
        print("✗ Bluetooth 初期化失敗:", e)
        while True:
            blink(2, on_ms=150, off_ms=150)
            time.sleep_ms(700)

    print("=" * 48)
    print("✓ Bluetooth: BLE(NUS) 広告開始  name=%s" % BLE_NAME)
    print("  Android の Chrome/Edge から接続してください")
    print("=" * 48)
    led.on()

    # 初期化が済んでからWDT起動（UART自動同期の待ち時間で誤リセットしない）
    wdt = WDT(timeout=WDT_TIMEOUT_MS)

    buf = b""
    last_gc = time.ticks_ms()

    while True:
        wdt.feed()

        # GNSSのNMEAを読み、行単位で BLE へ配信（無加工）
        try:
            if uart.any():
                buf += uart.read()
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()                   # \r や空白を除去
                if line:
                    ble.send_line(line)
            if len(buf) > 2048:                       # 暴走防止
                buf = b""
        except Exception as e:
            print("UART/送信エラー:", e)

        # 定期: メモリ回収
        if time.ticks_diff(time.ticks_ms(), last_gc) > 2000:
            last_gc = time.ticks_ms()
            gc.collect()

        time.sleep_ms(10)


main()
