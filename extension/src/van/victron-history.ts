// Pure parsing of the Victron SmartSolar's on-device history, as returned by
// `van-ble --victron-history` — no @raycast/api import, so it runs under
// vitest. The helper is transport only (it returns the raw register payloads
// as hex); every field is decoded here. Sources (verified, not remembered):
//   Victron "BlueSolar HEX protocol" Rev 18, § History data — register 0x104F
//     (total, 34 B on firmware ≥ 1.17) and 0x1050…0x106E (daily, 34 B)
//   patlux/ve-smart-telemetry fixtures/protocol (captured payloads)
// All fields are little-endian and unsigned.

import { hexToBytes } from "./parse";

export const VICTRON_TOTAL_VREG = 0x104f;
export const VICTRON_DAY_VREG_FIRST = 0x1050; // today; +N = N days ago
export const VICTRON_DAY_VREG_LAST = 0x106e;

const RECORD_LENGTH = 34;
const NOT_AVAILABLE_U32 = 0xffffffff;

export interface VictronDay {
  vreg: number;
  date: string; // local YYYY-MM-DD, `now` minus (vreg - 0x1050) days
  yieldWh: number;
  consumedWh: number | null; // null: model without a load output
  battVMax: number;
  battVMin: number;
  bulkMin: number;
  absMin: number;
  floatMin: number;
  maxPowerW: number;
  maxBattA: number;
  maxPvV: number;
  seq: number; // day sequence number, wraps at 365
  errors: number[]; // non-zero error codes, most recent first
}

export interface VictronTotal {
  userYieldKwh: number; // resettable
  systemYieldKwh: number;
  maxPvV: number;
  battVMax: number;
  battVMin: number | null; // firmware ≥ 1.17 only
  daysAvailable: number;
  errors: number[]; // non-zero error codes, most recent first
}

export interface VictronHistory {
  total: VictronTotal | null;
  days: VictronDay[]; // newest first; unreadable records are skipped
  errors: string[]; // helper error codes, e.g. victron-pairing-timeout
}

interface HistoryHelperOutput {
  victronHistory: {
    totalHex: string | null;
    days: { vreg: number; hex: string }[];
  } | null;
  errors: string[];
}

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const nonZero = (codes: ArrayLike<number>): number[] =>
  Array.from(codes).filter((c) => c !== 0);

const recordBytes = (hex: string): Uint8Array | null => {
  const bytes = hexToBytes(hex);
  return bytes && bytes.length === RECORD_LENGTH ? bytes : null;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

// Calendar arithmetic through setDate, so a DST change never shifts the day.
function localDate(now: Date | number, daysAgo: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Null for a payload that is not a 34-byte day record or a vreg outside
// 0x1050…0x106E.
export function parseVictronDay(
  hex: string,
  vreg: number,
  now: Date | number,
): VictronDay | null {
  if (vreg < VICTRON_DAY_VREG_FIRST || vreg > VICTRON_DAY_VREG_LAST)
    return null;
  const b = recordBytes(hex);
  if (!b) return null;
  const consumed = u32(b, 5);
  return {
    vreg,
    date: localDate(now, vreg - VICTRON_DAY_VREG_FIRST),
    yieldWh: u32(b, 1) * 10,
    consumedWh: consumed === NOT_AVAILABLE_U32 ? null : consumed * 10,
    battVMax: u16(b, 9) / 100,
    battVMin: u16(b, 11) / 100,
    bulkMin: u16(b, 18),
    absMin: u16(b, 20),
    floatMin: u16(b, 22),
    maxPowerW: u32(b, 24),
    maxBattA: u16(b, 28) / 10,
    maxPvV: u16(b, 30) / 100,
    seq: u16(b, 32),
    errors: nonZero(b.subarray(14, 18)),
  };
}

// Firmware 1.16 sends 19 bytes, ≥ 1.17 sends 34 (adds the battery minimum);
// both carry the fields up to byte 18.
export function parseVictronTotal(hex: string): VictronTotal | null {
  const b = hexToBytes(hex);
  if (!b || b.length < 19) return null;
  return {
    userYieldKwh: u32(b, 6) / 100,
    systemYieldKwh: u32(b, 10) / 100,
    maxPvV: u16(b, 14) / 100,
    battVMax: u16(b, 16) / 100,
    battVMin: b.length >= 21 ? u16(b, 19) / 100 : null,
    daysAvailable: b[18],
    errors: nonZero(b.subarray(2, 6)),
  };
}

// The helper's last stdout line → decoded history. Throws on output that is
// not the contract (like parseHelperOutput); a device-side failure is not a
// throw — it is `errors` with `total: null`, `days: []`.
export function parseHistoryOutput(
  json: string,
  now: Date | number = Date.now(),
): VictronHistory {
  const line = json
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) throw new Error("van-ble printed nothing");
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("van-ble printed an unexpected value");
  }
  const { victronHistory, errors } = raw as Partial<HistoryHelperOutput>;
  if (victronHistory && !Array.isArray(victronHistory.days)) {
    throw new Error("van-ble printed a malformed victron history");
  }
  const days = (victronHistory?.days ?? [])
    .map((d) => parseVictronDay(d.hex, d.vreg, now))
    .filter((d): d is VictronDay => d !== null)
    .sort((a, b) => a.vreg - b.vreg);
  return {
    total: victronHistory?.totalHex
      ? parseVictronTotal(victronHistory.totalHex)
      : null,
    days,
    errors: Array.isArray(errors) ? errors : [],
  };
}
