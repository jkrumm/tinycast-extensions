// van-ble — one-shot BLE reader for the Van Power command. Transport + AES
// decrypt only; every field is parsed in TypeScript (extension/src/van/parse.ts).
//
//   - Ective LiFePO4 (Topband BMS v1): connect, notify on FFE0/FFE4, reassemble
//     a CRC-valid 113-byte frame, disconnect. No auth, no writes.
//   - Victron SmartSolar (Instant Readout): passive — a manufacturer-data
//     advertisement (company 0x02E1), AES-128-CTR decrypted with the key read
//     from stdin (never argv).
//
// Prints exactly one JSON line to stdout and exits 0, even when a device was
// not found (see `errors`). `--selftest` checks the crypto + framing against
// known vectors and prints ok/fail. Tinycast Beta is the TCC-responsible
// process for Bluetooth; this binary is spawned by the extension, not bundled.

import CommonCrypto
import CoreBluetooth
import Foundation

let scanSeconds = 10.0
let hardDeadlineSeconds = 15.0
let batteryFrameLength = 113
let batteryStartBytes: Set<UInt8> = [0x5E, 0x83, 0xB0]
let batteryService = CBUUID(string: "FFE0")
let batteryCharacteristic = CBUUID(string: "FFE4")

// MARK: - Hex

func hexDecode(_ string: String) -> [UInt8]? {
    let chars = Array(string.utf8)
    guard chars.count % 2 == 0 else { return nil }
    var out = [UInt8]()
    out.reserveCapacity(chars.count / 2)
    func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x41...0x46: return c - 0x41 + 10
        case 0x61...0x66: return c - 0x61 + 10
        default: return nil
        }
    }
    var i = 0
    while i < chars.count {
        guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
        out.append(hi << 4 | lo)
        i += 2
    }
    return out
}

func hexEncode(_ bytes: [UInt8]) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
}

// MARK: - Ective frame framing

// Frame = SOF + 112 ASCII hex chars -> 56 bytes d[0..55]; CRC = sum(d[0..53])
// as uint16, big-endian in d[54..55].
func frameIsValid(_ frame: [UInt8]) -> Bool {
    guard frame.count == batteryFrameLength, batteryStartBytes.contains(frame[0]),
        let d = hexDecode(String(decoding: frame[1...], as: UTF8.self)), d.count == 56
    else { return false }
    let sum = d[0..<54].reduce(0) { $0 + Int($1) } & 0xFFFF
    return sum == Int(d[54]) << 8 | Int(d[55])
}

// Notifications arrive in arbitrary chunks: skip to a start byte, accumulate
// 113 bytes, accept on a valid CRC, otherwise drop that start byte and resync.
struct FrameAssembler {
    private var buffer = [UInt8]()

    mutating func feed(_ bytes: [UInt8]) -> [[UInt8]] {
        buffer.append(contentsOf: bytes)
        var frames = [[UInt8]]()
        while true {
            guard let start = buffer.firstIndex(where: { batteryStartBytes.contains($0) }) else {
                buffer.removeAll()
                break
            }
            if start > 0 { buffer.removeFirst(start) }
            if buffer.count < batteryFrameLength { break }
            let candidate = Array(buffer[0..<batteryFrameLength])
            if frameIsValid(candidate) {
                frames.append(candidate)
                buffer.removeFirst(batteryFrameLength)
            } else {
                buffer.removeFirst()
            }
        }
        return frames
    }
}

// MARK: - Victron AES-128-CTR

func aesEncryptBlock(key: [UInt8], block: [UInt8]) -> [UInt8]? {
    var out = [UInt8](repeating: 0, count: 16)
    var moved = 0
    let status = CCCrypt(
        CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionECBMode),
        key, key.count, nil, block, block.count, &out, out.count, &moved)
    return status == kCCSuccess && moved == 16 ? out : nil
}

// Mirrors pycryptodome `Counter.new(128, initial_value=iv, little_endian=True)`:
// the 16-byte counter block is the IV as a little-endian integer, incremented
// little-endian (byte 0 first) per block.
func victronDecrypt(key: [UInt8], iv: UInt16, ciphertext: [UInt8]) -> [UInt8]? {
    guard key.count == 16 else { return nil }
    var counter = [UInt8](repeating: 0, count: 16)
    counter[0] = UInt8(iv & 0xFF)
    counter[1] = UInt8(iv >> 8)
    var out = [UInt8]()
    var offset = 0
    while offset < ciphertext.count {
        guard let keystream = aesEncryptBlock(key: key, block: counter) else { return nil }
        for i in 0..<min(16, ciphertext.count - offset) {
            out.append(ciphertext[offset + i] ^ keystream[i])
        }
        var i = 0
        while i < 16 {
            counter[i] &+= 1
            if counter[i] != 0 { break }
            i += 1
        }
        offset += 16
    }
    return out
}

struct VictronReadout {
    let name: String?
    let rssi: Int
    let manufacturerHex: String
    let decryptedHex: String?
    let keyMismatch: Bool
}

// manufacturer = company id (E1 02) + prefix u16 (0x10 = Instant Readout record
// type) + model_id u16 + readout_type u8 (0x01 = solar charger) + iv u16 LE +
// encrypted bytes, of which [0] is the key check byte.
func parseVictron(manufacturer: [UInt8], name: String?, rssi: Int, key: [UInt8]?) -> VictronReadout? {
    guard manufacturer.count >= 2 + 7 + 1, manufacturer[0] == 0xE1, manufacturer[1] == 0x02,
        manufacturer[2] == 0x10, manufacturer[6] == 0x01
    else { return nil }
    let iv = UInt16(manufacturer[7]) | UInt16(manufacturer[8]) << 8
    let encrypted = Array(manufacturer[9...])
    var decryptedHex: String?
    var keyMismatch = false
    if let key = key, key.count == 16 {
        if encrypted[0] != key[0] {
            keyMismatch = true
        } else if let plain = victronDecrypt(key: key, iv: iv, ciphertext: Array(encrypted.dropFirst())) {
            decryptedHex = hexEncode(plain)
        }
    }
    return VictronReadout(
        name: name, rssi: rssi, manufacturerHex: hexEncode(manufacturer),
        decryptedHex: decryptedHex, keyMismatch: keyMismatch)
}

// MARK: - Victron history: wire protocol + write allowlist

// The SmartSolar's on-device 30-day daily history, read over a connected GATT
// session (VE.Smart service). Protocol facts: patlux/ve-smart-telemetry
// (decompiled VictronConnect, live-tested) + the BlueSolar HEX protocol PDF
// (register 0x104F total, 0x1050… daily). Read-only by construction — see
// `victronWriteAllowed`.

let victronService = CBUUID(string: "306b0001-b081-4037-83dc-e59fcc3cdfd0")
let victronControlUUID = CBUUID(string: "306b0002-b081-4037-83dc-e59fcc3cdfd0")
let victronLastDataUUID = CBUUID(string: "306b0003-b081-4037-83dc-e59fcc3cdfd0")
let victronDataUUID = CBUUID(string: "306b0004-b081-4037-83dc-e59fcc3cdfd0")

let victronTotalVreg: UInt16 = 0x104F
let victronHistoryVregs: ClosedRange<UInt16> = 0x104F...0x106E  // total + 0x1050 (today) … 0x106E
let victronMaxDays = 31  // 0x1050…0x106E
let victronCreditChunks = 65  // the app writes Control `f9 <n>` once it has received this many chunks

enum VictronChannel { case control, lastData }

let victronInitControl: [[UInt8]] = [[0xFA, 0x80, 0xFF], [0xF9, 0x80]]
let victronInitLastData: [[UInt8]] = [[0x01], [0x03, 0x00], [0x03, 0x01], [0x03, 0x03]]
// setValues(instance 0, [(vreg 0x93, bytes 10 27)]) — the keep-alive, 10000 ms.
let victronKeepAlive: [UInt8] = [0x06, 0x00, 0x82, 0x18, 0x93, 0x42, 0x10, 0x27]

// getValues(instance 3, [vreg]) — opcode 05, the only request the history needs.
func victronGetFrame(vreg: UInt16, instance: UInt8 = 0x03) -> [UInt8] {
    [0x05, instance, 0x81, 0x19, UInt8(vreg >> 8), UInt8(vreg & 0xFF)]
}

// SAFETY (hard rule): the ONLY outbound frames are the init bytes, the
// keep-alive (vreg 0x93 exactly), the Control credit `f9 <n>`, and GET
// (opcode 05) for vregs 0x104F…0x106E. No other opcode-06 write exists, and
// 0x1030 (clear history) is outside the range. Every write goes through
// `HistoryReader.safeWrite`, which asks this and aborts on false.
func victronWriteAllowed(
    channel: VictronChannel, bytes: [UInt8], probe: [VictronProbeTarget] = [], trends: Bool = false
) -> Bool {
    switch channel {
    case .control:
        return victronInitControl.contains(bytes) || (bytes.count == 2 && bytes[0] == 0xF9)
    case .lastData:
        if victronInitLastData.contains(bytes) || bytes == victronKeepAlive { return true }
        if trends, victronIsTrendRequest(bytes) { return true }
        guard bytes.count == 6, bytes[0] == 0x05, bytes[2] == 0x81, bytes[3] == 0x19 else { return false }
        let vreg = UInt16(bytes[4]) << 8 | UInt16(bytes[5])
        if bytes[1] == 0x03, victronHistoryVregs.contains(vreg) { return true }
        if trends, bytes[1] == 0x03, victronTrendReadVregs.contains(vreg) { return true }
        // Probe mode (`--victron-probe`): GET (opcode 05, a pure read by protocol — the
        // app's own getValues) for exactly the listed instance/vreg pairs, never 0x1030.
        return vreg != victronClearHistoryVreg && probe.contains(VictronProbeTarget(instance: bytes[1], vreg: vreg))
    }
}

let victronClearHistoryVreg: UInt16 = 0x1030

// Stored trends (`--victron-trends`). VictronConnect's own getValues set for the trend
// store: supported-vreg list 0xEC5D, last time reference 0xEC5A, active time tuple
// 0xEC5F, config 0xEC4A…0xEC51 and time refs 0xEC52…0xEC59 per trend.
let victronTrendReadVregs: Set<UInt16> = Set([0xEC5D, 0xEC5A, 0xEC5F] + Array(0xEC4A...0xEC59))
let victronTrendPushVreg: UInt16 = 0xEC5B
let victronTrendMaxPush = 56  // the device's per-reply limit (config byte 1, 0x38 on the 8-bit trends)

// The ONE write beyond the keep-alive: VictronConnect's standard trends request, a
// setValues (06) on instance 3, vreg 0xEC5B (VE_REG_TREND_PUSH_DATA, "SET vreg to send
// parameters and retrieve data"), bstr of exactly 6 bytes `[u8 trend][u32 LE timeRef]
// [u8 maxPush]`. Trend index < 8 and 1…56 samples. 0xEC5C (clear), 0xEC63/0xEC64 (lists),
// 0xEC5F and everything else stay blocked.
func victronTrendRequestFrame(trend: UInt8, timeRef: UInt32, maxPush: UInt8) -> [UInt8] {
    [0x06, 0x03, 0x82, 0x19, 0xEC, 0x5B, 0x46, trend]
        + (0..<4).map { UInt8(truncatingIfNeeded: timeRef >> (8 * UInt32($0))) } + [maxPush]
}

func victronIsTrendRequest(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 13, Array(bytes[0..<7]) == [0x06, 0x03, 0x82, 0x19, 0xEC, 0x5B, 0x46] else { return false }
    return bytes[7] < 8 && bytes[12] >= 1 && Int(bytes[12]) <= victronTrendMaxPush
}

struct VictronProbeTarget: Equatable {
    let instance: UInt8  // 0 or 3 only
    let vreg: UInt16
}

// `--victron-probe` argument: comma-separated `0xEC5D` (instance 3) or `0:0x0100`
// (instance 0). 0x1030 and instances other than 0/3 are refused.
func victronParseProbe(_ argument: String) -> [VictronProbeTarget]? {
    var targets = [VictronProbeTarget]()
    for item in argument.split(separator: ",") {
        let parts = item.split(separator: ":", maxSplits: 1).map(String.init)
        let (instanceText, vregText) = parts.count == 2 ? (parts[0], parts[1]) : ("3", parts[0])
        let digits = vregText.lowercased().hasPrefix("0x") ? String(vregText.dropFirst(2)) : vregText
        guard let instance = UInt8(instanceText), instance == 0 || instance == 3,
            let vreg = UInt16(digits, radix: 16), vreg != victronClearHistoryVreg
        else { return nil }
        targets.append(VictronProbeTarget(instance: instance, vreg: vreg))
    }
    return targets.isEmpty ? nil : targets
}

struct VictronValue: Equatable {
    let instance: UInt16
    let vreg: UInt16
    let data: [UInt8]
}

enum CborError: Error { case incomplete, malformed }

private func cborHead(_ b: [UInt8], _ pos: inout Int) throws -> (major: UInt8, arg: UInt64, indefinite: Bool) {
    guard pos < b.count else { throw CborError.incomplete }
    let initial = b[pos]
    pos += 1
    let major = initial >> 5
    let info = initial & 0x1F
    switch info {
    case 0..<24:
        return (major, UInt64(info), false)
    case 24...27:
        let n = 1 << Int(info - 24)
        guard pos + n <= b.count else { throw CborError.incomplete }
        var value: UInt64 = 0
        for i in 0..<n { value = value << 8 | UInt64(b[pos + i]) }
        pos += n
        return (major, value, false)
    case 31:
        return (major, 0, true)
    default:
        throw CborError.malformed
    }
}

private func cborUint(_ b: [UInt8], _ pos: inout Int) throws -> UInt64 {
    let head = try cborHead(b, &pos)
    guard head.major == 0, !head.indefinite else { throw CborError.malformed }
    return head.arg
}

private func cborSkip(_ b: [UInt8], _ pos: inout Int) throws {
    let head = try cborHead(b, &pos)
    switch head.major {
    case 0, 1:
        guard !head.indefinite else { throw CborError.malformed }
    case 2, 3:
        guard !head.indefinite, head.arg <= 0xFFFF else { throw CborError.malformed }
        guard pos + Int(head.arg) <= b.count else { throw CborError.incomplete }
        pos += Int(head.arg)
    case 4, 5:
        let perItem = head.major == 5 ? 2 : 1
        if head.indefinite {
            while true {
                guard pos < b.count else { throw CborError.incomplete }
                if b[pos] == 0xFF {
                    pos += 1
                    return
                }
                for _ in 0..<perItem { try cborSkip(b, &pos) }
            }
        }
        guard head.arg < 4096 else { throw CborError.malformed }
        for _ in 0..<Int(head.arg) * perItem { try cborSkip(b, &pos) }
    case 6:
        try cborSkip(b, &pos)
    default:
        guard !head.indefinite else { throw CborError.malformed }
    }
}

// Reads the concatenated CBOR records of the Data/LastData stream. Only the
// Value record (`08 <inst> <vreg> <bstr>`) is returned; acks (07), value
// responses (09) and the device list (02) are skipped. `rest` is an incomplete
// trailing record to keep for the next chunk — or empty after a malformed one.
struct VictronResponse: Equatable {
    let instance: UInt16
    let vreg: UInt16
    let code: Int
}

func victronParseStream(_ bytes: [UInt8]) -> (values: [VictronValue], rest: [UInt8], responses: [VictronResponse]) {
    var values = [VictronValue]()
    var responses = [VictronResponse]()
    var pos = 0
    while pos < bytes.count {
        let start = pos
        do {
            let opcode = try cborUint(bytes, &pos)
            switch opcode {
            case 0x08:
                let instance = try cborUint(bytes, &pos)
                let vreg = try cborUint(bytes, &pos)
                let head = try cborHead(bytes, &pos)
                guard head.major == 2, !head.indefinite, head.arg <= 0xFFFF, instance <= 0xFFFF, vreg <= 0xFFFF
                else {
                    throw CborError.malformed
                }
                guard pos + Int(head.arg) <= bytes.count else { throw CborError.incomplete }
                values.append(
                    VictronValue(
                        instance: UInt16(instance), vreg: UInt16(vreg),
                        data: Array(bytes[pos..<pos + Int(head.arg)])))
                pos += Int(head.arg)
            case 0x09:
                let instance = try cborUint(bytes, &pos)
                let vreg = try cborUint(bytes, &pos)
                let head = try cborHead(bytes, &pos)
                guard head.major <= 1, head.arg < 0x10000, instance <= 0xFFFF, vreg <= 0xFFFF else {
                    throw CborError.malformed
                }
                let code = head.major == 0 ? Int(head.arg) : -1 - Int(head.arg)
                responses.append(
                    VictronResponse(instance: UInt16(instance), vreg: UInt16(vreg), code: code))
            case 0x07:
                for _ in 0..<3 { try cborSkip(bytes, &pos) }
            case 0x02:
                try cborSkip(bytes, &pos)
            default:
                throw CborError.malformed
            }
        } catch CborError.incomplete {
            return (values, Array(bytes[start...]), responses)
        } catch {
            return (values, [], responses)
        }
    }
    return (values, [], responses)
}

// The history reply for a register — not the instance-0 keep-alive echo or any
// other pushed value.
func victronIsHistoryValue(_ value: VictronValue) -> Bool {
    value.instance != 0 && victronHistoryVregs.contains(value.vreg)
}

// MARK: - Victron history: GATT session

let historyScanSeconds = 10.0
let historyConnectSeconds = 15.0
let historyPairingSeconds = 60.0  // macOS' own passkey dialog, first encrypted access only
let historyReadSeconds = 45.0  // after the Control read: negotiation + total + days
let trendsReadSeconds = 60.0  // the 72 h stitch is ~100 pushes at ~0.1 s each
let historyReplySeconds = 4.0
let historyKeepAliveSeconds = 3.0
let historyWriteSpacing = 0.25

// Diagnostics go to stderr — stdout stays the one JSON line.
func diag(_ message: String) {
    FileHandle.standardError.write(Data("van-ble: \(message)\n".utf8))
}

final class HistoryReader: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private enum Phase { case scanning, connecting, discovering, subscribing, readingControl, running, finished }

    private var central: CBCentralManager!
    private var phase = Phase.scanning
    private var errors = [String]()
    private var peripheral: CBPeripheral?
    private var control: CBCharacteristic?
    private var lastData: CBCharacteristic?
    private var data: CBCharacteristic?
    private var notifyPending = Set<CBUUID>()

    private var buffer = [UInt8]()
    private var inboundChunks = 0
    private var total: [UInt8]?
    private var days = [UInt16: [UInt8]]()
    private var awaiting: UInt16?
    private var awaitToken = 0
    private var onReply: (() -> Void)?
    private var keepAlive: Timer?

    // `--victron-probe`: GET-only raw reads of arbitrary vregs, see `victronWriteAllowed`.
    private let probe: [VictronProbeTarget]
    private var probeValues = [VictronValue]()
    private var probeResponses = [VictronResponse]()
    private var probeAwaiting: VictronProbeTarget?

    // `--victron-trends`: GET the trend config, then VictronConnect's own push request.
    private let trendsMode: Bool
    private let wantHistory: Bool  // the daily history (alone, or before the trends in `--victron-all`)
    private var emptyTrends = Set<UInt8>()  // trends whose first reply was all "not available"
    private var seenTrends = Set<UInt8>()
    private let trendsOnce: (trend: UInt8, timeRef: UInt32, maxPush: UInt8)?
    private var trendsAnchor: (timeRef: UInt32, unixMs: Int64)?
    private var pushAwaiting = false
    private var pushReplies = [[UInt8]]()  // EC5B values since the current request
    private var pushLog = [[String: Any]]()

    // `--since`: only samples newer than this unix-ms instant (minus one step) are requested.
    private let sinceMs: Int64?
    private let reportHistory: Bool  // `--victron-all`: always carries a `victronHistory` key (null when skipped)

    init(
        probe: [VictronProbeTarget] = [], trends: Bool = false, all: Bool = false,
        once: (UInt8, UInt32, UInt8)? = nil, sinceMs: Int64? = nil, skipHistory: Bool = false
    ) {
        self.probe = probe
        self.sinceMs = sinceMs
        self.reportHistory = all
        self.trendsMode = trends || all
        self.wantHistory = (all && !skipHistory) || (!trends && !all && probe.isEmpty)
        self.trendsOnce = once.map { (trend: $0.0, timeRef: $0.1, maxPush: $0.2) }
        super.init()
        central = CBCentralManager(
            delegate: self, queue: .main,
            options: [CBCentralManagerOptionShowPowerAlertKey: false])
        after(historyScanSeconds + 5) { [self] in
            if phase == .scanning, !central.isScanning { finish("bluetooth-unavailable") }
        }
    }

    private func after(_ seconds: Double, _ block: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: block)
    }

    // MARK: central

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            guard phase == .scanning, !central.isScanning else { return }
            central.scanForPeripherals(
                withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
            after(historyScanSeconds) { [self] in
                guard phase == .scanning else { return }
                central.stopScan()
                finish("victron-not-found")
            }
        case .unauthorized:
            finish("bluetooth-unauthorized")
        case .poweredOff:
            finish("bluetooth-off")
        case .unsupported:
            finish("bluetooth-unsupported")
        default:
            break  // .unknown / .resetting — the unavailable deadline in init covers a stuck state
        }
    }

    func centralManager(
        _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any], rssi RSSI: NSNumber
    ) {
        guard phase == .scanning,
            let manufacturer = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
            parseVictron(manufacturer: [UInt8](manufacturer), name: nil, rssi: 0, key: nil) != nil
        else { return }
        central.stopScan()
        phase = .connecting
        self.peripheral = peripheral  // CoreBluetooth does not retain it
        peripheral.delegate = self
        central.connect(peripheral, options: nil)
        after(historyConnectSeconds) { [self] in
            if phase == .connecting { finish("victron-connect-failed") }
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard phase == .connecting else { return }
        phase = .discovering
        peripheral.discoverServices([victronService])
        // Covers discovery, notify enabling and the Control read — the first
        // encrypted access is what makes macOS show its pairing dialog.
        after(historyPairingSeconds) { [self] in
            switch phase {
            case .discovering, .subscribing, .readingControl: finish("victron-pairing-timeout")
            default: break
            }
        }
    }

    func centralManager(
        _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
    ) {
        finish("victron-connect-failed")
    }

    func centralManager(
        _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
    ) {
        if phase == .finished { return emit() }
        finish("victron-disconnected")
    }

    // MARK: discovery

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard phase == .discovering else { return }
        guard let service = peripheral.services?.first(where: { $0.uuid == victronService }) else {
            return finish("victron-service-missing")
        }
        peripheral.discoverCharacteristics(
            [victronControlUUID, victronLastDataUUID, victronDataUUID], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
    ) {
        guard phase == .discovering else { return }
        let found = service.characteristics ?? []
        control = found.first { $0.uuid == victronControlUUID }
        lastData = found.first { $0.uuid == victronLastDataUUID }
        data = found.first { $0.uuid == victronDataUUID }
        guard let control = control, let lastData = lastData, let data = data else {
            return finish("victron-service-missing")
        }
        phase = .subscribing
        notifyPending = [control.uuid, lastData.uuid, data.uuid]
        for characteristic in [control, lastData, data] {
            peripheral.setNotifyValue(true, for: characteristic)
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard phase == .subscribing else { return }
        if let error = error {
            diag("enable notify \(characteristic.uuid): \(error)")
            return finish("victron-pairing-failed")
        }
        notifyPending.remove(characteristic.uuid)
        guard notifyPending.isEmpty, let control = control else { return }
        phase = .readingControl
        peripheral.readValue(for: control)
    }

    // MARK: inbound

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        if let error = error {
            diag("read \(characteristic.uuid): \(error)")
            if phase == .readingControl { finish("victron-pairing-failed") }
            return
        }
        guard let value = characteristic.value.map({ [UInt8]($0) }) else { return }
        switch characteristic.uuid {
        case victronControlUUID:
            if phase == .readingControl {
                phase = .running
                startSession()
            } else if value.first == 0xF8 {
                buffer.removeAll()
            }
        case victronDataUUID, victronLastDataUUID:
            guard phase == .running else { return }
            inbound(value, endOfFrame: characteristic.uuid == victronLastDataUUID)
        default:
            break
        }
    }

    // Data chunks concatenate; a LastData chunk ends the frame, so an
    // incomplete tail is dropped there.
    private func inbound(_ chunk: [UInt8], endOfFrame: Bool) {
        buffer += chunk
        let parsed = victronParseStream(buffer)
        buffer = endOfFrame ? [] : parsed.rest
        if !probe.isEmpty {
            for value in parsed.values { recordProbe(value) }
            for response in parsed.responses { recordProbeResponse(response) }
        } else {
            for value in parsed.values {
                if trendsMode { recordProbe(value) }
                if wantHistory, victronIsHistoryValue(value) { record(value) }
            }
            if trendsMode { for response in parsed.responses { recordProbeResponse(response) } }
        }

        inboundChunks += 1
        if inboundChunks >= victronCreditChunks {
            safeWrite(.control, [0xF9, UInt8(inboundChunks)])
            inboundChunks = 0
        }
    }

    private func record(_ value: VictronValue) {
        if value.vreg == victronTotalVreg {
            total = value.data
        } else {
            days[value.vreg] = value.data
        }
        guard value.vreg == awaiting, let next = onReply else { return }
        awaiting = nil
        onReply = nil
        after(0.05, next)
    }

    private func recordProbe(_ value: VictronValue) {
        probeValues.append(value)
        if pushAwaiting, value.instance == 3, value.vreg == victronTrendPushVreg {
            pushReplies.append(value.data)
            advancePush()
            return
        }
        if trendsMode, value.instance == 3, value.vreg == 0xEC5A, value.data.count == 4 {
            trendsAnchor = (
                UInt32(value.data[0]) | UInt32(value.data[1]) << 8 | UInt32(value.data[2]) << 16
                    | UInt32(value.data[3]) << 24,
                Int64(Date().timeIntervalSince1970 * 1000)
            )
        }
        guard let target = probeAwaiting, Int(target.instance) == Int(value.instance),
            target.vreg == value.vreg
        else { return }
        advanceProbe()
    }

    private func recordProbeResponse(_ response: VictronResponse) {
        probeResponses.append(response)
        if pushAwaiting, response.instance == 3, response.vreg == victronTrendPushVreg {
            pushLog.append(["responseCode": response.code])
            advancePush()
            return
        }
        guard let target = probeAwaiting, Int(target.instance) == Int(response.instance),
            target.vreg == response.vreg
        else { return }
        advanceProbe()
    }

    private func advanceProbe() {
        guard let next = onReply else { return }
        probeAwaiting = nil
        onReply = nil
        after(0.05, next)
    }

    private func probeNext(_ index: Int) {
        probeSequence(probe, from: index) { [self] in finish(nil) }
    }

    private func probeSequence(_ targets: [VictronProbeTarget], from index: Int, then done: @escaping () -> Void) {
        guard phase == .running else { return }
        guard index < targets.count else { return done() }
        let target = targets[index]
        guard safeWrite(.lastData, victronGetFrame(vreg: target.vreg, instance: target.instance)) else { return }
        probeAwaiting = target
        onReply = { [self] in probeSequence(targets, from: index + 1, then: done) }
        awaitToken += 1
        let token = awaitToken
        after(historyReplySeconds) { [self] in
            guard phase == .running, awaitToken == token, probeAwaiting == target else { return }
            probeAwaiting = nil
            onReply = nil
            let error = "victron-reply-timeout:\(target.instance):\(String(target.vreg, radix: 16))"
            if !errors.contains(error) { errors.append(error) }
            probeSequence(targets, from: index + 1, then: done)
        }
    }

    // MARK: trends

    private var trendsReads: [VictronProbeTarget] {
        ([0xEC5D] + Array(0xEC4A...0xEC59) + [0xEC5F, 0xEC5A]).map { VictronProbeTarget(instance: 3, vreg: UInt16($0)) }
    }

    private func latest(_ vreg: UInt16) -> [UInt8]? {
        probeValues.last { $0.instance == 3 && $0.vreg == vreg }?.data
    }

    private func startTrends() {
        guard let once = trendsOnce else { return probeSequence(trendsReads, from: 0) { [self] in planTrends() } }
        probeSequence(trendsReads, from: 0) { [self] in
            pushNext([(once.trend, once.timeRef, once.maxPush)], from: 0) { [self] in finish(nil) }
        }
    }

    // Stitches the last 72 h from the cascading subtrends (config pairs: samples u16, step u16;
    // time refs: newest ref u32 per subtrend): 3 = 30 min (ends ~26 h ago), 2 = 5 min (~2–26 h),
    // 1 = 30 s (the last ~2 h). Per subtrend the requests walk back from its newest ref by
    // `maxPush × step`; the device picks the subtrend from the timeRef's age.
    private func planTrends() {
        guard let supported = latest(0xEC5D), supported.count == 16 else {
            return finish("victron-trends-unsupported")
        }
        guard let anchor = trendsAnchor else { return finish("victron-trends-no-anchor") }
        var windowStart = Int64(anchor.timeRef) - 72 * 3600
        if let sinceMs = sinceMs {
            // The cached series ends at `sinceMs`: translate it into the device clock via the anchor.
            let sinceRef = Int64(anchor.timeRef) - (anchor.unixMs - sinceMs) / 1000
            windowStart = max(windowStart, sinceRef)
        }
        var requests = [(UInt8, UInt32, UInt8)]()
        for index in 0..<8 {
            let vreg = UInt16(supported[2 * index]) | UInt16(supported[2 * index + 1]) << 8
            guard vreg != 0xFFFF, vreg != 0 else { break }
            guard let config = latest(UInt16(0xEC4A + index)), config.count >= 18,
                let refs = latest(UInt16(0xEC52 + index)), refs.count >= 16
            else { return finish("victron-trends-config-missing") }
            let maxPush = Int(config[1])
            guard maxPush >= 1, maxPush <= victronTrendMaxPush else { return finish("victron-trends-config-invalid") }
            for sub in [3, 2, 1] {
                let configured = Int(config[2 + 4 * sub]) | Int(config[3 + 4 * sub]) << 8
                let step = Int(config[4 + 4 * sub]) | Int(config[5 + 4 * sub]) << 8
                let o = 4 * sub
                let newest = UInt32(refs[o]) | UInt32(refs[o + 1]) << 8 | UInt32(refs[o + 2]) << 16
                    | UInt32(refs[o + 3]) << 24
                guard step > 0, configured > 0, newest != 0xFFFF_FFFF, newest != 0 else { continue }
                // One step of overlap, so the newest cached sample is re-read and replaced.
                let needed = Int((Int64(newest) - windowStart + Int64(step) - 1) / Int64(step)) + 2
                let samples = min(configured, max(needed, 0))
                let span = UInt32(maxPush * step)
                var done = 0
                var timeRef = newest
                while done < samples, timeRef > span {
                    requests.append((UInt8(index), timeRef, UInt8(maxPush)))
                    done += maxPush
                    timeRef -= span
                }
            }
        }
        pushNext(requests, from: 0) { [self] in finish(nil) }
    }

    // A trend whose first reply is entirely "not available" (no sensor, no load output) is skipped.
    private func allUnavailable(_ block: [UInt8]) -> Bool {
        guard block.count > 8, block[5] > 0, (block.count - 8) % Int(block[5]) == 0 else { return false }
        let width = (block.count - 8) / Int(block[5])
        let body = Array(block[8...])
        if width == 1 { return body.allSatisfy { $0 == 0xFF || $0 == 0x7F } }
        guard width == 2 else { return false }
        return stride(from: 0, to: body.count, by: 2).allSatisfy {
            let word = UInt16(body[$0]) | UInt16(body[$0 + 1]) << 8
            return word == 0xFFFF || word == 0x7FFF
        }
    }

    private func pushNext(_ requests: [(UInt8, UInt32, UInt8)], from index: Int, then done: @escaping () -> Void) {
        guard phase == .running else { return }
        guard index < requests.count else { return done() }
        let request = requests[index]
        if emptyTrends.contains(request.0) { return pushNext(requests, from: index + 1, then: done) }
        let frame = victronTrendRequestFrame(trend: request.0, timeRef: request.1, maxPush: request.2)
        pushReplies = []
        pushAwaiting = true
        guard safeWrite(.lastData, frame) else { return }
        let sentAt = Date()
        onReply = { [self] in
            pushLog.append([
                "trend": Int(request.0), "timeRef": Int(request.1), "maxPush": Int(request.2),
                "ms": Int(Date().timeIntervalSince(sentAt) * 1000),
                "replies": pushReplies.map(hexEncode),
            ])
            if seenTrends.insert(request.0).inserted, let first = pushReplies.first, allUnavailable(first) {
                emptyTrends.insert(request.0)
            }
            pushNext(requests, from: index + 1, then: done)
        }
        awaitToken += 1
        let token = awaitToken
        after(historyReplySeconds) { [self] in
            guard phase == .running, awaitToken == token, pushAwaiting else { return }
            pushAwaiting = false
            onReply = nil
            let error = "victron-trend-reply-timeout:\(request.0):\(request.1)"
            if !errors.contains(error) { errors.append(error) }
            pushLog.append(["trend": Int(request.0), "timeRef": Int(request.1), "timeout": true])
            pushNext(requests, from: index + 1, then: done)
        }
    }

    private func advancePush() {
        guard let next = onReply else { return }
        pushAwaiting = false
        onReply = nil
        after(0.05, next)
    }

    // MARK: session

    private func startSession() {
        // History + trends share one session, so the guard covers both.
        after(wantHistory && trendsMode ? historyReadSeconds + trendsReadSeconds : historyReadSeconds) { [self] in
            guard phase == .running else { return }
            finish("victron-history-timeout")
        }
        var steps = [(VictronChannel, [UInt8])]()
        for bytes in victronInitControl { steps.append((.control, bytes)) }
        let initial = victronInitLastData
        steps += [
            (.lastData, initial[0]), (.lastData, initial[1]), (.lastData, victronKeepAlive),
            (.lastData, initial[2]), (.lastData, initial[3]),
        ]
        send(steps, from: 0) { [self] in
            keepAlive = Timer.scheduledTimer(withTimeInterval: historyKeepAliveSeconds, repeats: true) {
                [self] _ in safeWrite(.lastData, victronKeepAlive)
            }
            after(1.0) { [self] in
                if !probe.isEmpty {
                    probeNext(0)
                } else if wantHistory {
                    requestTotal()
                } else {
                    startTrends()
                }  // drain the pushed values
            }
        }
    }

    private func send(_ steps: [(VictronChannel, [UInt8])], from index: Int, then done: @escaping () -> Void) {
        guard phase == .running else { return }
        guard index < steps.count else { return done() }
        guard safeWrite(steps[index].0, steps[index].1) else { return }
        after(historyWriteSpacing) { [self] in send(steps, from: index + 1, then: done) }
    }

    private func requestTotal() {
        request(victronTotalVreg) { [self] in
            guard let total = total, total.count > 18 else {
                guard trendsMode else { return finish("victron-total-unreadable") }
                errors.append("victron-total-unreadable")  // partial success: the trends can still work
                return startTrends()
            }
            requestDays(count: min(Int(total[18]), victronMaxDays), index: 0)
        }
    }

    private func requestDays(count: Int, index: Int) {
        guard phase == .running else { return }
        guard index < count else { return trendsMode ? startTrends() : finish(nil) }
        request(0x1050 + UInt16(index)) { [self] in requestDays(count: count, index: index + 1) }
    }

    // One GET, then `next` on its reply — or after a reply timeout, so one
    // silent register does not lose the remaining days.
    private func request(_ vreg: UInt16, then next: @escaping () -> Void) {
        guard phase == .running, safeWrite(.lastData, victronGetFrame(vreg: vreg)) else { return }
        awaiting = vreg
        onReply = next
        awaitToken += 1
        let token = awaitToken
        after(historyReplySeconds) { [self] in
            guard phase == .running, awaitToken == token, awaiting == vreg else { return }
            awaiting = nil
            onReply = nil
            let error = "victron-reply-timeout"
            if !errors.contains(error) { errors.append(error) }
            next()
        }
    }

    // The single outbound path. Anything off the allowlist aborts the session.
    @discardableResult
    private func safeWrite(_ channel: VictronChannel, _ bytes: [UInt8]) -> Bool {
        guard victronWriteAllowed(channel: channel, bytes: bytes, probe: probe, trends: trendsMode) else {
            finish("victron-unsafe-write-blocked")
            return false
        }
        guard let peripheral = peripheral, let characteristic = channel == .control ? control : lastData else {
            return false
        }
        let type: CBCharacteristicWriteType =
            characteristic.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
        peripheral.writeValue(Data(bytes), for: characteristic, type: type)
        return true
    }

    func peripheral(
        _ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        if error != nil, phase == .running { finish("victron-write-failed") }
    }

    // MARK: completion

    private func finish(_ error: String?) {
        guard phase != .finished else { return }
        if let error = error { errors.append(error) }
        phase = .finished
        keepAlive?.invalidate()
        guard let peripheral = peripheral else { return emit() }
        central.cancelPeripheralConnection(peripheral)
        after(1.5) { [self] in emit() }  // didDisconnect normally gets there first
    }

    private var emitted = false

    private func emit() {
        guard !emitted else { return }
        emitted = true
        if !probe.isEmpty {
            let object: [String: Any] = [
                "victronProbe": [
                    "requested": probe.map { "\($0.instance):0x\(String($0.vreg, radix: 16))" },
                    "values": probeValues.map {
                        ["instance": Int($0.instance), "vreg": "0x" + String($0.vreg, radix: 16), "hex": hexEncode($0.data)]
                            as [String: Any]
                    },
                    "responses": probeResponses.map {
                        ["instance": Int($0.instance), "vreg": "0x" + String($0.vreg, radix: 16), "code": $0.code]
                            as [String: Any]
                    },
                ] as [String: Any],
                "errors": errors,
            ]
            print(jsonString(object))
            fflush(stdout)
            exit(0)
        }
        var output = [String: Any]()
        if trendsMode {
            func hexOf(_ vreg: UInt16) -> Any { latest(vreg).map(hexEncode) as Any? ?? NSNull() }
            output["victronTrendsRaw"] =
                trendsAnchor == nil || pushLog.isEmpty
                ? NSNull()
                : [
                    "anchor": ["timeRef": Int(trendsAnchor!.timeRef), "unixMs": trendsAnchor!.unixMs],
                    "supportedHex": hexOf(0xEC5D),
                    "tupleHex": hexOf(0xEC5F),
                    "configsHex": (0..<8).map { hexOf(UInt16(0xEC4A + $0)) },
                    "timeRefsHex": (0..<8).map { hexOf(UInt16(0xEC52 + $0)) },
                    "pushes": pushLog,
                ] as [String: Any]
        }
        let history: Any =
            total == nil && days.isEmpty
            ? NSNull()
            : [
                "totalHex": total.map(hexEncode) as Any? ?? NSNull(),
                "days": days.keys.sorted().map { ["vreg": Int($0), "hex": hexEncode(days[$0]!)] as [String: Any] },
            ] as [String: Any]
        if wantHistory { output["victronHistory"] = history } else if reportHistory { output["victronHistory"] = NSNull() }
        output["errors"] = errors
        print(jsonString(output))
        fflush(stdout)
        exit(0)
    }
}

// MARK: - Selftest

// Vectors: keshavdv/victron-ble tests/test_solar_charger.py (end-to-end parse,
// decrypted prefix) and syssi/esphome-topband-bms frames_ective.h.
func selftest() -> String? {
    let key = hexDecode("adeccb947395801a4dd45a2eaa44bf17")!
    let advert = hexDecode("100242a0016207adceb37b605d7e0ee21b24df5c")!
    let manufacturer = [UInt8(0xE1), 0x02] + advert
    guard let read = parseVictron(manufacturer: manufacturer, name: nil, rssi: 0, key: key) else {
        return "victron advert not recognised"
    }
    guard !read.keyMismatch, read.decryptedHex == "04006c050e000300130000fe" else {
        return "victron decrypt mismatch: \(read.decryptedHex ?? "nil")"
    }
    var wrong = key
    wrong[0] ^= 0xFF
    guard parseVictron(manufacturer: manufacturer, name: nil, rssi: 0, key: wrong)?.keyMismatch == true else {
        return "victron key check not enforced"
    }

    let payload =
        "84350000" + "F8CDFFFF" + "2CF90200" + "9701" + "6200" + "E10B" + "0000" + "0000"
        + "5E0D" + "710D" + "650D" + "5E0D" + String(repeating: "0", count: 48) + "094F"
    let frame = [UInt8(0x5E)] + Array(payload.utf8)
    guard frameIsValid(frame) else { return "ective frame CRC invalid" }
    var corrupt = frame
    corrupt[5] = UInt8(ascii: "9")
    guard !frameIsValid(corrupt) else { return "ective CRC accepts a corrupt frame" }

    var assembler = FrameAssembler()
    let stream = [UInt8(0x00), 0x11] + frame + corrupt + frame
    var found = [[UInt8]]()
    var i = 0
    while i < stream.count {
        found += assembler.feed(Array(stream[i..<min(i + 20, stream.count)]))
        i += 20
    }
    guard found.count == 2, found.allSatisfy({ $0 == frame }) else {
        return "ective reassembly found \(found.count) frames"
    }
    return victronHistorySelftest()
}

// Frame parser + write allowlist. Fixtures: patlux/ve-smart-telemetry
// fixtures/protocol (captured on a SmartSolar; the history payloads are
// captured, the record wrapper is the crate's own CBOR encoder).
func victronHistorySelftest() -> String? {
    let total = "010012000000f7dc0100f7dc01006b14e80a1e0100" + String(repeating: "ff", count: 13)
    let day = "009400000000000000a20a7009000000000053038200000012020000bf0079135c00"
    let totalRecord = hexDecode("080319104f5822" + total)!
    guard total.count == 68 else { return "history total fixture length \(total.count)" }
    let dayRecord = hexDecode("0803191050582200" + day.dropFirst(2))!

    let whole = victronParseStream(totalRecord + dayRecord)
    guard whole.values.count == 2, whole.rest.isEmpty, whole.values[0].vreg == 0x104F,
        whole.values[1].vreg == 0x1050, whole.values[1].instance == 3,
        hexEncode(whole.values[0].data) == total, hexEncode(whole.values[1].data).count == 68
    else { return "history stream parse mismatch" }

    // Notifications split anywhere: an incomplete tail is kept, then completes.
    for cut in 1..<dayRecord.count {
        let first = victronParseStream(Array(dayRecord[0..<cut]))
        guard first.values.isEmpty, first.rest.count == cut else { return "history split at \(cut) lost bytes" }
        let second = victronParseStream(first.rest + Array(dayRecord[cut...]))
        guard second.values.count == 1, second.rest.isEmpty else { return "history split at \(cut) not completed" }
    }

    // Acks, the device list and the instance-0 keep-alive echo are not history.
    let noise = victronParseStream(
        hexDecode("07000300" + "029f000001000301ff" + "08001893421027" + "080319ed8d42ba09")!)
    guard noise.values.count == 2, noise.rest.isEmpty, !noise.values.contains(where: victronIsHistoryValue) else {
        return "history noise not ignored"
    }
    guard victronIsHistoryValue(whole.values[1]) else { return "history value not recognised" }
    guard victronParseStream([0x0F, 0x00]).rest.isEmpty, victronParseStream([0x0F, 0x00]).values.isEmpty else {
        return "history malformed opcode not dropped"
    }

    // Allowlist: exactly the init bytes, the keep-alive, the credit and GET 0x104F…0x106E.
    for bytes in victronInitControl where !victronWriteAllowed(channel: .control, bytes: bytes) {
        return "allowlist rejects control init \(hexEncode(bytes))"
    }
    for bytes in victronInitLastData + [victronKeepAlive] where !victronWriteAllowed(channel: .lastData, bytes: bytes) {
        return "allowlist rejects lastData init \(hexEncode(bytes))"
    }
    guard victronWriteAllowed(channel: .control, bytes: [0xF9, 65]) else { return "allowlist rejects credit" }
    for vreg in victronHistoryVregs where !victronWriteAllowed(channel: .lastData, bytes: victronGetFrame(vreg: vreg)) {
        return "allowlist rejects GET \(String(vreg, radix: 16))"
    }
    guard victronGetFrame(vreg: 0x104F) == hexDecode("05038119104f")!,
        victronGetFrame(vreg: 0x106E) == hexDecode("05038119106e")!
    else { return "GET frame encoding" }
    let forbidden: [(VictronChannel, [UInt8])] = [
        (.lastData, victronGetFrame(vreg: 0x1030)),  // clear history
        (.lastData, victronGetFrame(vreg: 0x104E)),
        (.lastData, victronGetFrame(vreg: 0x106F)),
        (.lastData, victronGetFrame(vreg: 0x0093)),
        (.lastData, [0x06, 0x03, 0x82, 0x19, 0x10, 0x30, 0x41, 0x01]),  // setValues clear history
        (.lastData, [0x06, 0x00, 0x82, 0x18, 0x93, 0x42, 0x11, 0x27]),  // keep-alive, other value
        (.lastData, [0x06, 0x00, 0x82, 0x18, 0x94, 0x42, 0x10, 0x27]),  // keep-alive, other vreg
        (.lastData, [0x05, 0x03, 0x81, 0x19, 0x10, 0x50, 0x00]),  // GET with trailing byte
        (.lastData, [0x05, 0x04, 0x81, 0x19, 0x10, 0x50]),  // GET other instance
        (.lastData, [0x0B, 0x03, 0x81, 0x00]),
        (.lastData, []),
        (.control, [0xFA, 0x80, 0xFE]),
        (.control, [0xF7, 0x03, 0x00]),
        (.control, [0xF9]),
        (.control, victronGetFrame(vreg: 0x1050)),
    ]
    for (channel, bytes) in forbidden where victronWriteAllowed(channel: channel, bytes: bytes) {
        return "allowlist accepts \(hexEncode(bytes))"
    }
    guard !victronWriteAllowed(channel: .control, bytes: victronInitLastData[0]) else {
        return "allowlist ignores the channel"
    }
    return victronProbeSelftest() ?? victronTrendsSelftest()
}

// Probe-mode allowlist: GET only, exactly the listed instance/vreg pairs.
func victronProbeSelftest() -> String? {
    guard let targets = victronParseProbe("0xEC5D,EC5A,0:0x0100") else { return "probe parse" }
    guard targets == [
        VictronProbeTarget(instance: 3, vreg: 0xEC5D), VictronProbeTarget(instance: 3, vreg: 0xEC5A),
        VictronProbeTarget(instance: 0, vreg: 0x0100),
    ] else { return "probe parse result" }
    guard victronParseProbe("0x1030") == nil, victronParseProbe("3:0x1030") == nil,
        victronParseProbe("4:0xEC5D") == nil, victronParseProbe("zz") == nil, victronParseProbe("") == nil
    else { return "probe parse accepts a forbidden target" }
    for target in targets {
        let frame = victronGetFrame(vreg: target.vreg, instance: target.instance)
        guard victronWriteAllowed(channel: .lastData, bytes: frame, probe: targets) else {
            return "probe rejects GET \(hexEncode(frame))"
        }
    }
    guard victronGetFrame(vreg: 0xEC5D) == hexDecode("05038119ec5d")!
    else { return "probe GET frame encoding" }
    let forbidden: [[UInt8]] = [
        victronGetFrame(vreg: 0xEC5B),  // not listed
        victronGetFrame(vreg: 0xEC5D, instance: 0),  // listed for instance 3 only
        victronGetFrame(vreg: 0x1030),  // clear history, even as a GET
        [0x06, 0x03, 0x81, 0x19, 0xEC, 0x5D],  // setValues, same shape as a GET
        [0x06, 0x03, 0x82, 0x19, 0xEC, 0x5B, 0x46, 1, 2, 3, 4, 5, 6],  // trend push request (a SET)
        [0x06, 0x03, 0x82, 0x19, 0xEC, 0x5C, 0x41, 0x01],  // trends clear
        [0x05, 0x03, 0x81, 0x19, 0xEC, 0x5D, 0x00],  // trailing byte
        [0x0B, 0x03, 0x81, 0x00],  // path API
    ]
    for bytes in forbidden where victronWriteAllowed(channel: .lastData, bytes: bytes, probe: targets) {
        return "probe allowlist accepts \(hexEncode(bytes))"
    }
    guard !victronWriteAllowed(channel: .lastData, bytes: victronGetFrame(vreg: 0xEC5D), probe: []) else {
        return "probe vreg allowed outside probe mode"
    }
    // 09 (value response) is surfaced: `09 03 19 ec5d 03` = instance 3, vreg, code 3.
    let reject = victronParseStream(hexDecode("090319ec5d03")!)
    guard reject.responses == [VictronResponse(instance: 3, vreg: 0xEC5D, code: 3)], reject.values.isEmpty else {
        return "value response not parsed"
    }
    return nil
}

// Trends allowlist: exactly the one extra write, only in trends mode.
func victronTrendsSelftest() -> String? {
    let ok = victronTrendRequestFrame(trend: 4, timeRef: 0x01CC_2DDB, maxPush: 28)
    guard ok == hexDecode("06038219ec5b46" + "04" + "db2dcc01" + "1c")! else { return "trend frame encoding" }
    guard victronWriteAllowed(channel: .lastData, bytes: ok, trends: true) else { return "trends rejects its request" }
    guard !victronWriteAllowed(channel: .lastData, bytes: ok) else { return "trend request allowed outside trends mode" }
    guard !victronWriteAllowed(channel: .lastData, bytes: ok, probe: [VictronProbeTarget(instance: 3, vreg: 0xEC5B)])
    else { return "trend request allowed in probe mode" }
    for vreg in victronTrendReadVregs.sorted()
    where !victronWriteAllowed(channel: .lastData, bytes: victronGetFrame(vreg: vreg), trends: true) {
        return "trends rejects GET \(String(vreg, radix: 16))"
    }
    let forbidden: [[UInt8]] = [
        victronGetFrame(vreg: 0xEC5B),  // GET of the push vreg (refused by the device anyway)
        victronGetFrame(vreg: 0xEC5C),
        victronGetFrame(vreg: 0xEC63),
        victronGetFrame(vreg: 0x1030),
        victronGetFrame(vreg: 0xEC5D, instance: 0),
        victronGetFrame(vreg: 0xEC4A - 1),
        victronGetFrame(vreg: 0xEC5A + 1 + 1),  // 0xEC5C
        [0x06, 0x03, 0x82, 0x19, 0xEC, 0x5C, 0x41, 0x01],  // trends clear
        [0x06, 0x03, 0x82, 0x19, 0xEC, 0x5C, 0x46, 4, 0, 0, 0, 0, 1],  // clear with push-shaped payload
        [0x06, 0x03, 0x82, 0x19, 0xEC, 0x63, 0x46, 4, 0, 0, 0, 0, 1],  // time-tuple list
        [0x06, 0x03, 0x82, 0x19, 0xEC, 0x64, 0x46, 4, 0, 0, 0, 0, 1],  // reboot list
        [0x06, 0x03, 0x82, 0x19, 0xEC, 0x5F, 0x48, 0, 0, 0, 0, 0, 0, 0, 0],  // set the active time tuple
        [0x06, 0x03, 0x82, 0x19, 0x10, 0x30, 0x46, 4, 0, 0, 0, 0, 1],  // clear history, push-shaped
        [0x06, 0x00, 0x82, 0x19, 0xEC, 0x5B, 0x46, 4, 0, 0, 0, 0, 1],  // push on instance 0
        [0x06, 0x04, 0x82, 0x19, 0xEC, 0x5B, 0x46, 4, 0, 0, 0, 0, 1],
        Array(ok.dropLast()),  // payload too short
        ok + [0],  // payload too long
        Array(ok[0..<6]) + [0x47] + Array(ok[7...]) + [0],  // bstr length 7
        Array(ok[0..<4]) + [0xEC, 0x5B] + [0x46, 8, 0, 0, 0, 0, 1],  // trend index out of range
        victronTrendRequestFrame(trend: 4, timeRef: 1, maxPush: 0),  // no samples
        victronTrendRequestFrame(trend: 4, timeRef: 1, maxPush: 57),  // above the device limit
        [0x06, 0x03, 0x81, 0x19, 0xEC, 0x5B],  // set shape of a GET
        [0x07, 0x03, 0x82, 0x19, 0xEC, 0x5B, 0x46, 4, 0, 0, 0, 0, 1],  // other opcode
        [0x0A, 0x03], [0x0B, 0x03, 0x81, 0x00], [0x0C, 0x03, 0x82, 0x00, 0x00],  // path API
    ]
    for bytes in forbidden where victronWriteAllowed(channel: .lastData, bytes: bytes, trends: true) {
        return "trends allowlist accepts \(hexEncode(bytes))"
    }
    guard victronWriteAllowed(channel: .lastData, bytes: victronKeepAlive, trends: true),
        !victronWriteAllowed(channel: .control, bytes: ok, trends: true)
    else { return "trends keep-alive / channel" }
    return nil
}

// MARK: - Scan

func jsonString(_ object: Any) -> String {
    let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
}

final class Reader: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private let victronKey: [UInt8]?
    private var errors: [String]

    private var scanning = false
    private var finished = false

    private var peripheral: CBPeripheral?
    private var assembler = FrameAssembler()
    private var batteryName = ""
    private var batteryRssi = 0
    private var batteryFound = false
    private var batteryConnected = false
    private var batteryDone = false
    private var batteryFrame: [UInt8]?

    private var victron: VictronReadout?
    private var victronDone = false

    init(victronKey: [UInt8]?, errors: [String]) {
        self.victronKey = victronKey
        self.errors = errors
        super.init()
        central = CBCentralManager(
            delegate: self, queue: .main,
            options: [CBCentralManagerOptionShowPowerAlertKey: false])
        DispatchQueue.main.asyncAfter(deadline: .now() + hardDeadlineSeconds) { [self] in finish() }
    }

    // MARK: central

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            guard !scanning else { return }
            scanning = true
            central.scanForPeripherals(
                withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
            DispatchQueue.main.asyncAfter(deadline: .now() + scanSeconds) { [self] in endScan() }
        case .unauthorized:
            fail("bluetooth-unauthorized")
        case .poweredOff:
            fail("bluetooth-off")
        case .unsupported:
            fail("bluetooth-unsupported")
        default:
            break  // .unknown / .resetting — wait; the hard deadline covers a stuck state
        }
    }

    private func fail(_ error: String) {
        errors.append(error)
        batteryDone = true
        victronDone = true
        finish()
    }

    func centralManager(
        _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any], rssi RSSI: NSNumber
    ) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name
        let rssi = RSSI.intValue

        if !victronDone, let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
            let readout = parseVictron(
                manufacturer: [UInt8](data), name: name, rssi: rssi, key: victronKey)
        {
            victron = readout
            victronDone = true
            checkDone()
        }

        guard !batteryFound else { return }
        let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        guard name?.hasPrefix("NWJ") == true || services.contains(batteryService) else { return }
        batteryFound = true
        batteryName = name ?? ""
        batteryRssi = rssi
        self.peripheral = peripheral  // CoreBluetooth does not retain it
        peripheral.delegate = self
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        batteryConnected = true
        peripheral.discoverServices([batteryService])
    }

    func centralManager(
        _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
    ) {
        batteryDone = true
        errors.append("battery-connect-failed")
        checkDone()
    }

    func centralManager(
        _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
    ) {
        guard !batteryDone else { return }
        batteryDone = true
        errors.append("battery-disconnected")
        checkDone()
    }

    // MARK: peripheral

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == batteryService }) else {
            return batteryFailed("battery-service-missing")
        }
        peripheral.discoverCharacteristics([batteryCharacteristic], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
    ) {
        guard let characteristic = service.characteristics?.first(where: { $0.uuid == batteryCharacteristic })
        else { return batteryFailed("battery-characteristic-missing") }
        peripheral.setNotifyValue(true, for: characteristic)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        guard !batteryDone, let value = characteristic.value else { return }
        guard let frame = assembler.feed([UInt8](value)).first else { return }
        batteryFrame = frame
        batteryDone = true
        central.cancelPeripheralConnection(peripheral)
        checkDone()
    }

    private func batteryFailed(_ error: String) {
        guard !batteryDone else { return }
        batteryDone = true
        errors.append(error)
        if let peripheral = peripheral { central.cancelPeripheralConnection(peripheral) }
        checkDone()
    }

    // MARK: completion

    private func endScan() {
        guard !finished else { return }
        central.stopScan()
        if !batteryFound {
            batteryDone = true
            errors.append("battery-not-found")
        }
        victronDone = true
        checkDone()
    }

    private func checkDone() {
        if batteryDone && victronDone { finish() }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        if !scanning && errors.isEmpty { errors.append("bluetooth-unavailable") }
        if !batteryDone && batteryFrame == nil {
            errors.append(
                !batteryFound ? "battery-not-found" : !batteryConnected ? "battery-connect-failed" : "battery-no-frame")
        }
        if victron == nil && scanning && !errors.contains("victron-not-found") {
            errors.append("victron-not-found")
        }
        let battery: Any =
            batteryFrame.map {
                ["name": batteryName, "frameHex": hexEncode($0), "rssi": batteryRssi] as [String: Any]
            } ?? NSNull()
        let victronJson: Any =
            victron.map {
                [
                    "name": $0.name as Any? ?? NSNull(),
                    "rssi": $0.rssi,
                    "manufacturerHex": $0.manufacturerHex,
                    "decryptedHex": $0.decryptedHex as Any? ?? NSNull(),
                    "keyMismatch": $0.keyMismatch,
                ] as [String: Any]
            } ?? NSNull()
        print(jsonString(["battery": battery, "victron": victronJson, "errors": errors]))
        fflush(stdout)
        exit(0)
    }
}

// MARK: - Main

if CommandLine.arguments.contains("--selftest") {
    if let failure = selftest() {
        print("fail: \(failure)")
        exit(1)
    }
    print("ok")
    exit(0)
}

if let flag = CommandLine.arguments.firstIndex(of: "--victron-probe") {
    guard flag + 1 < CommandLine.arguments.count, let targets = victronParseProbe(CommandLine.arguments[flag + 1])
    else {
        print("usage: van-ble --victron-probe 0xEC5D,0xEC5A[,0:0x0100] (instance 3 default; 0x1030 refused)")
        exit(2)
    }
    let reader = HistoryReader(probe: targets)
    withExtendedLifetime(reader) { RunLoop.main.run() }
}

if let flag = CommandLine.arguments.firstIndex(of: "--victron-trends") {
    // Optional debug form: `--victron-trends <trend>:<timeRef>:<maxPush>` sends that one request only.
    var once: (UInt8, UInt32, UInt8)?
    if flag + 1 < CommandLine.arguments.count {
        let parts = CommandLine.arguments[flag + 1].split(separator: ":").map(String.init)
        guard parts.count == 3, let trend = UInt8(parts[0]), let ref = UInt32(parts[1]), let n = UInt8(parts[2]),
            victronIsTrendRequest(victronTrendRequestFrame(trend: trend, timeRef: ref, maxPush: n))
        else {
            print("usage: van-ble --victron-trends [<trend>:<timeRef>:<maxPush>]")
            exit(2)
        }
        once = (trend, ref, n)
    }
    let reader = HistoryReader(trends: true, once: once)
    withExtendedLifetime(reader) { RunLoop.main.run() }
}

// One connected session for the daily history AND the 72 h trends (one connect, one pairing
// check); a failure in one part keeps the other: `{victronHistory, victronTrendsRaw, errors}`.
if CommandLine.arguments.contains("--victron-all") {
    var sinceMs: Int64?
    if let flag = CommandLine.arguments.firstIndex(of: "--since") {
        guard flag + 1 < CommandLine.arguments.count, let value = Int64(CommandLine.arguments[flag + 1]), value > 0
        else {
            print("usage: van-ble --victron-all [--since <unixMs>] [--skip-history]")
            exit(2)
        }
        sinceMs = value
    }
    let reader = HistoryReader(all: true, sinceMs: sinceMs, skipHistory: CommandLine.arguments.contains("--skip-history"))
    withExtendedLifetime(reader) { RunLoop.main.run() }
}

if CommandLine.arguments.contains("--victron-history") {
    let history = HistoryReader()
    withExtendedLifetime(history) { RunLoop.main.run() }
}

var startupErrors = [String]()
var key: [UInt8]?
if isatty(STDIN_FILENO) == 0 {
    let input = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if !input.isEmpty {
        if input.count == 32, let bytes = hexDecode(input) {
            key = bytes
        } else {
            startupErrors.append("victron-key-invalid")
        }
    }
}

let reader = Reader(victronKey: key, errors: startupErrors)
withExtendedLifetime(reader) { RunLoop.main.run() }
