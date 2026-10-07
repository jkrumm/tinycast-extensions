// Pure parsing of what the van-ble helper returns — no @raycast/api import, so
// it runs under vitest. Protocol sources (verified, not remembered):
//   Ective / Topband v1 BMS: syssi/esphome-topband-bms (Apache-2.0),
//     tests/components/topband_bms_v1_ble/frames_ective.h
//   Victron Instant Readout: keshavdv/victron-ble, victron_ble/devices/
//     solar_charger.py + base.py (BitReader, OperationMode)

import {
  EctiveReading,
  HelperBattery,
  HelperResult,
  Sample,
  SolarReading,
  VanReading,
} from "./types";

export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ─── Ective frame ───────────────────────────────────────────────────────────

const FRAME_LENGTH = 113; // SOF + 112 ASCII hex chars
const FRAME_START_BYTES = new Set([0x5e, 0x83, 0xb0]);

// Bits of the u16 at d[18].
const ERROR_FLAGS = [
  "Charge over-temp",
  "Discharge over-temp",
  "Charge under-temp",
  "Discharge under-temp",
  "Discharge over-current",
  "Charge over-current",
  "Under-voltage",
  "Over-voltage",
];

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

// `frameHex` is the helper's hex of the whole 113-byte frame. Null when the
// frame is malformed or its CRC (sum of d[0..53], big-endian in d[54..55])
// does not match.
export function parseEctiveFrame(frameHex: string): EctiveReading | null {
  const frame = hexToBytes(frameHex);
  if (!frame || frame.length !== FRAME_LENGTH) return null;
  if (!FRAME_START_BYTES.has(frame[0])) return null;
  const d = hexToBytes(String.fromCharCode(...frame.subarray(1)));
  if (!d || d.length !== 56) return null;

  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let sum = 0;
  for (let i = 0; i < 54; i++) sum += d[i];
  if ((sum & 0xffff) !== view.getUint16(54, false)) return null;

  const cellsMv: number[] = [];
  for (let i = 0; i < 16; i++) {
    const mv = view.getUint16(22 + i * 2, true);
    if (mv !== 0) cellsMv.push(mv);
  }
  const errorMask = view.getUint16(18, true);

  return {
    packVoltageV: view.getUint32(0, true) / 1000,
    cellSumV:
      cellsMv.length > 0
        ? round(cellsMv.reduce((a, b) => a + b, 0) / 1000, 3)
        : null,
    currentA: view.getInt32(4, true) / 1000,
    capacityAh: view.getUint32(8, true) / 1000,
    cycles: view.getUint16(12, true),
    soc: view.getUint16(14, true),
    tempC: round(view.getUint16(16, true) / 10 - 273.15, 2),
    errorMask,
    errorFlags: ERROR_FLAGS.filter((_, bit) => (errorMask & (1 << bit)) !== 0),
    afeStatus: view.getUint16(20, true),
    cellsMv,
  };
}

// ─── Victron solar charger ──────────────────────────────────────────────────

// victron-ble base.py OperationMode (from the VE.Direct docs).
const OPERATION_MODE: Record<number, string> = {
  0: "Off",
  1: "Low power",
  2: "Fault",
  3: "Bulk",
  4: "Absorption",
  5: "Float",
  6: "Storage",
  7: "Equalize",
  9: "Inverting",
  11: "Power supply",
  245: "Starting up",
  246: "Repeated absorption",
  247: "Recondition",
  248: "Battery safe",
  249: "Active",
  252: "External control",
};

// Bit-packed LSB-first, exactly like victron-ble's BitReader.
class BitReader {
  private index = 0;
  constructor(private readonly data: Uint8Array) {}

  unsigned(bits: number): number {
    let value = 0;
    for (let position = 0; position < bits; position++) {
      const bit = (this.data[this.index >> 3] >> (this.index & 7)) & 1;
      value += bit * 2 ** position;
      this.index++;
    }
    return value;
  }

  signed(bits: number): number {
    const value = this.unsigned(bits);
    return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
  }
}

const SOLAR_BITS = 8 + 8 + 16 + 16 + 16 + 16 + 9;

export function parseVictronSolar(decryptedHex: string): SolarReading | null {
  const bytes = hexToBytes(decryptedHex);
  if (!bytes || bytes.length * 8 < SOLAR_BITS) return null;
  const r = new BitReader(bytes);
  const chargeState = r.unsigned(8);
  const chargerError = r.unsigned(8);
  const batteryV = r.signed(16);
  const chargeA = r.signed(16);
  const yieldTen = r.unsigned(16);
  const solarW = r.unsigned(16);
  const loadTenth = r.unsigned(9);

  return {
    chargeState: chargeState !== 0xff ? chargeState : null,
    stateLabel:
      chargeState !== 0xff
        ? (OPERATION_MODE[chargeState] ?? `State ${chargeState}`)
        : null,
    chargerError: chargerError !== 0xff ? chargerError : null,
    batteryV: batteryV !== 0x7fff ? batteryV / 100 : null,
    chargeA: chargeA !== 0x7fff ? chargeA / 10 : null,
    yieldWh: yieldTen !== 0xffff ? yieldTen * 10 : null,
    solarW: solarW !== 0xffff ? solarW : null,
    loadA: loadTenth !== 0x1ff ? loadTenth / 10 : null,
  };
}

// ─── Helper result → reading ────────────────────────────────────────────────

const BATTERY_ISSUES: Record<string, string> = {
  "battery-not-found": "Battery BMS not in range.",
  "battery-connect-failed":
    "Battery BMS connection failed — close the phone app, it may hold the only connection.",
};

function bluetoothIssue(errors: string[]): string | null {
  if (errors.includes("bluetooth-unauthorized")) {
    return "Bluetooth access denied — allow Tinycast Beta in System Settings → Privacy & Security → Bluetooth.";
  }
  if (errors.includes("bluetooth-off")) return "Bluetooth is off.";
  const other = errors.find((e) => e.startsWith("bluetooth-"));
  return other ? `Bluetooth unavailable (${other}).` : null;
}

function batteryIssue(
  battery: HelperBattery | null,
  errors: string[],
): string | null {
  if (battery && parseEctiveFrame(battery.frameHex)) return null;
  if (battery) return "Battery BMS sent an invalid frame.";
  const known = errors.find((e) => BATTERY_ISSUES[e]);
  if (known) return BATTERY_ISSUES[known];
  const other = errors.find((e) => e.startsWith("battery-"));
  return `Battery BMS could not be read${other ? ` (${other})` : ""}.`;
}

export function toReading(opts: {
  helper: HelperResult;
  keyMissing: boolean;
  now: number;
}): VanReading {
  const { helper, keyMissing, now } = opts;
  const bluetooth = bluetoothIssue(helper.errors);
  if (bluetooth) {
    return { battery: null, solar: null, issues: [bluetooth], readAt: now };
  }

  const issues: string[] = [];
  const battery = helper.battery
    ? parseEctiveFrame(helper.battery.frameHex)
    : null;
  const bmsIssue = batteryIssue(helper.battery, helper.errors);
  if (bmsIssue) issues.push(bmsIssue);

  let solar: SolarReading | null = null;
  const victron = helper.victron;
  if (!victron) {
    issues.push("Solar charger not in range.");
  } else if (victron.keyMismatch) {
    issues.push(
      "Victron key mismatch — check the Instant Readout key (`make secrets`).",
    );
  } else if (!victron.decryptedHex) {
    issues.push(
      keyMissing
        ? "Victron key missing — run `make secrets`."
        : "Victron data could not be decrypted.",
    );
  } else {
    solar = parseVictronSolar(victron.decryptedHex);
    if (!solar) issues.push("Victron data could not be parsed.");
  }

  return { battery, solar, issues, readAt: now };
}

// ─── Helper stdout ──────────────────────────────────────────────────────────

// The helper prints exactly one JSON line; anything else is a crash.
export function parseHelperOutput(stdout: string): HelperResult {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) throw new Error("van-ble printed nothing");
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("van-ble printed an unexpected value");
  }
  const { battery, victron, errors } = raw as Partial<HelperResult>;
  if (battery && typeof battery.frameHex !== "string") {
    throw new Error("van-ble printed a malformed battery result");
  }
  if (victron && typeof victron.manufacturerHex !== "string") {
    throw new Error("van-ble printed a malformed victron result");
  }
  return {
    battery: battery ?? null,
    victron: victron ?? null,
    errors: Array.isArray(errors) ? errors : [],
  };
}

// ─── Reading → history sample ───────────────────────────────────────────────

export function toSample(reading: VanReading): Sample {
  const { battery, solar } = reading;
  const cells = battery?.cellsMv ?? [];
  return {
    t: reading.readAt,
    soc: battery?.soc ?? null,
    batV: battery?.cellSumV ?? battery?.packVoltageV ?? solar?.batteryV ?? null,
    batA: battery?.currentA ?? null,
    cellMinV: cells.length > 0 ? Math.min(...cells) / 1000 : null,
    cellMaxV: cells.length > 0 ? Math.max(...cells) / 1000 : null,
    tempC: battery?.tempC ?? null,
    pvW: solar?.solarW ?? null,
    chgA: solar?.chargeA ?? null,
    loadA: solar?.loadA ?? null,
    yieldWh: solar?.yieldWh ?? null,
    state: solar?.stateLabel ?? null,
  };
}
