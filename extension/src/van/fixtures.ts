// Real-protocol fixtures shared by the unit and e2e suites.
//   Ective: syssi/esphome-topband-bms tests/components/topband_bms_v1_ble/
//     frames_ective.h — 13.7 V, −12.808 A, 194.86 Ah, 407 cycles, SOC 98 %,
//     ~31 °C, no errors, cells 3.422 / 3.441 / 3.429 / 3.422 V.
//   Victron: keshavdv/victron-ble tests/test_solar_charger.py — key
//     adeccb94…bf17, Absorption, 13.88 V, 1.4 A, 30 Wh, 19 W, load 0.0 A.

import { HelperResult, Sample } from "./types";
import { VictronDay, VictronHistory } from "./victron-history";
import {
  VictronAllResult,
  VictronTrends,
  decodeTrends,
} from "./victron-trends";
import { TRENDS_CAPTURE } from "./victron-trends.fixture";

// 56 decoded bytes as ASCII hex (the frame's 112 payload chars).
export const ECTIVE_PAYLOAD =
  "84350000F8CDFFFF2CF9020097016200E10B00000000" +
  "5E0D710D650D5E0D" +
  "0".repeat(48) +
  "094F";

const ascii = (text: string): string =>
  Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(
    "",
  );

// SOF 0x5E + payload — what the helper reports as `frameHex`.
export const ECTIVE_FRAME_HEX = `5e${ascii(ECTIVE_PAYLOAD)}`;

export const VICTRON_KEY = "adeccb947395801a4dd45a2eaa44bf17";
export const VICTRON_MANUFACTURER_HEX =
  "e102100242a0016207adceb37b605d7e0ee21b24df5c";
export const VICTRON_DECRYPTED_HEX = "04006c050e000300130000fe";

export const HELPER_FULL: HelperResult = {
  battery: { name: "NWJ00000000000000", frameHex: ECTIVE_FRAME_HEX, rssi: -63 },
  victron: {
    name: "Van Solar",
    rssi: -65,
    manufacturerHex: VICTRON_MANUFACTURER_HEX,
    decryptedHex: VICTRON_DECRYPTED_HEX,
    keyMismatch: false,
  },
  errors: [],
};

export const HELPER_NO_KEY: HelperResult = {
  ...HELPER_FULL,
  victron: { ...HELPER_FULL.victron!, decryptedHex: null },
};

export const HELPER_BATTERY_BUSY: HelperResult = {
  battery: null,
  victron: HELPER_FULL.victron,
  errors: ["battery-connect-failed"],
};

export const HELPER_BLUETOOTH_OFF: HelperResult = {
  battery: null,
  victron: null,
  errors: ["bluetooth-off"],
};

// A believable day-and-a-half of opens: SoC sags overnight, solar lifts it
// by day, the pack current follows. Ascending, ending at `now`.
export function fixtureSamples(now: number, count = 12): Sample[] {
  const spacing = (36 * 3_600_000) / count;
  return Array.from({ length: count }, (_, i) => {
    const t = now - (count - 1 - i) * spacing;
    const hour = new Date(t).getHours();
    const sun = hour >= 8 && hour <= 18;
    const pvW = sun
      ? Math.round(60 + 140 * Math.sin(((hour - 8) / 10) * Math.PI))
      : 0;
    const batA = sun ? pvW / 14 - 3 : -3.5;
    return {
      t,
      soc: Math.round(Math.min(100, Math.max(20, 70 + i * 2 + (sun ? 8 : -6)))),
      batV: 13.4,
      batA: Math.round(batA * 10) / 10,
      cellMinV: 3.35,
      cellMaxV: 3.36,
      tempC: 24,
      pvW,
      chgA: Math.round((pvW / 13.6) * 10) / 10,
      loadA: null,
      yieldWh: sun ? pvW * 10 : 0,
      state: sun ? "Bulk" : "Off",
    };
  });
}

// Thirty days of the Victron's own history, newest first (today = 0x1050):
// a few grey days among sunny ones, today still partial.
export function fixtureVictronHistory(now: number, count = 30): VictronHistory {
  const yields = [380, 1480, 1210, 90, 1620, 1750, 640, 1330, 1840, 1100];
  const days: VictronDay[] = Array.from({ length: count }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const yieldWh = yields[i % yields.length] + (i % 3) * 40;
    return {
      vreg: 0x1050 + i,
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      yieldWh,
      consumedWh: null,
      battVMax: Math.round((13.9 + ((i * 7) % 5) * 0.12) * 100) / 100,
      battVMin:
        Math.round(
          (12.9 + ((i * 3) % 4) * 0.1 - (yieldWh < 200 ? 0.3 : 0)) * 100,
        ) / 100,
      bulkMin: 300,
      absMin: 60,
      floatMin: 20,
      maxPowerW: Math.round(yieldWh / 5.5),
      maxBattA: 12,
      maxPvV: 48,
      seq: 100 - i,
      errors: [],
    };
  });
  return {
    total: {
      userYieldKwh: 61.2,
      systemYieldKwh: 61.2,
      maxPvV: 49.9,
      battVMax: 14.4,
      battVMin: 11.9,
      daysAvailable: count,
      errors: [],
    },
    days,
    errors: [],
  };
}

// The real captured trends (victron-trends.fixture.ts: 72 h of PV power and
// battery V/A from a live SmartSolar), shifted so the capture's "now" is `now`
// — so a chart drawn at `now` shows the real shape — plus the 30-day history.
export function fixtureVictronAll(now: number): VictronAllResult {
  const trends = decodeTrends(TRENDS_CAPTURE)!;
  const shift = now - trends.anchor.unixMs;
  return {
    history: fixtureVictronHistory(now),
    trends: {
      anchor: { ...trends.anchor, unixMs: now },
      trends: trends.trends.map((trend) => ({
        ...trend,
        samples: trend.samples.map((sample) => ({
          ...sample,
          t: sample.t + shift,
        })),
      })),
    },
    errors: [],
  };
}

// A synthetic van whose true charge is exact, for testing the SoC estimator and
// its evaluation: sunny days 06:30–17:30 (`sunA` into the pack), the charger
// asleep at night (0 A, its voltage frozen at 13.00 V — the stale value the real
// SmartSolar holds), a constant `loadA` house load, starting at `startSoc` %.
// When the pack reaches full the surplus is not stored: the charger moves to
// absorption (14.2 V, current tapering to 1 A) and the truth is pinned to 100.
export function simulateVan(opts: {
  from: number;
  to: number;
  loadA?: number;
  capacityAh?: number;
  sunA?: number;
  startSoc?: number;
}) {
  const { from, to } = opts;
  const loadA = opts.loadA ?? 1;
  const capacityAh = opts.capacityAh ?? 100;
  const sunA = opts.sunA ?? 8;
  const STEP = 5 * 60_000;
  const hourOf = (t: number) => {
    const d = new Date(t);
    return d.getHours() + d.getMinutes() / 60;
  };
  const awake = (t: number) => hourOf(t) >= 6.5 && hourOf(t) < 17.5;
  const times: number[] = [];
  for (let t = from; t <= to; t += STEP) times.push(t);
  const truth = new Map<number, number>();
  const chargeA = new Map<number, number>();
  const volts = new Map<number, number>();
  let soc = opts.startSoc ?? 50;
  for (const t of times) {
    let a = awake(t) ? sunA : 0;
    const step = (a: number) =>
      (((a - loadA) * (STEP / 3_600_000)) / capacityAh) * 100;
    const full = awake(t) && soc + step(a) >= 100;
    if (full) a = 1;
    soc = full ? 100 : Math.min(100, Math.max(0, soc + step(a)));
    truth.set(t, soc);
    chargeA.set(t, a);
    volts.set(t, full ? 14.2 : awake(t) ? 13.5 : 13.0);
  }
  const series = (vreg: number, f: (t: number) => number) => ({
    vreg,
    segments: [{ stepS: 300, fromMs: from, toMs: to, count: times.length }],
    samples: times.map((t) => ({ t, v: f(t) })),
  });
  const trends: VictronTrends = {
    anchor: { timeRef: 0, unixMs: to },
    trends: [
      series(0xec8a, (t) => (awake(t) ? 150 : 0)),
      series(0xed8f, (t) => chargeA.get(t)!),
      series(0xed8d, (t) => volts.get(t)!),
    ],
  };
  const snap = (t: number) => Math.round((t - from) / STEP) * STEP + from;
  return {
    trends,
    times,
    capacityAh,
    loadA,
    awake,
    truthAt: (t: number) => truth.get(snap(t))!,
    chargeAAt: (t: number) => chargeA.get(snap(t))!,
  };
}
