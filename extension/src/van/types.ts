// Contract of the van-ble helper (extension/helpers/van-ble/main.swift): one
// JSON line on stdout. The helper is transport + AES decrypt only — every
// field below is parsed in parse.ts.
export interface HelperBattery {
  name: string;
  frameHex: string; // the full 113-byte frame incl. SOF, hex-encoded
  rssi: number;
}

export interface HelperVictron {
  name: string | null;
  rssi: number;
  manufacturerHex: string; // raw manufacturer data incl. the company id
  decryptedHex: string | null; // null: no key, or the key-check byte mismatched
  keyMismatch: boolean;
}

export interface HelperResult {
  battery: HelperBattery | null;
  victron: HelperVictron | null;
  errors: string[];
}

// Ective LiFePO4 (Topband BMS v1) frame, decoded.
export interface EctiveReading {
  packVoltageV: number; // the BMS's own (coarse) pack voltage
  cellSumV: number | null; // sum of the non-zero cells — the better pack voltage
  currentA: number; // negative = discharging, positive = charging
  capacityAh: number; // full capacity
  cycles: number;
  soc: number; // %
  tempC: number;
  errorMask: number;
  errorFlags: string[];
  afeStatus: number;
  cellsMv: number[]; // non-zero cells only
}

// Victron SmartSolar MPPT Instant Readout, decoded. null = "not available".
export interface SolarReading {
  chargeState: number | null;
  stateLabel: string | null;
  chargerError: number | null;
  batteryV: number | null;
  chargeA: number | null;
  yieldWh: number | null;
  solarW: number | null;
  loadA: number | null; // the MPPT's load output, when it has one
}

export interface VanReading {
  battery: EctiveReading | null;
  solar: SolarReading | null;
  issues: string[]; // human one-liners: what could not be read, and why
  readAt: number; // epoch ms
}

// One persisted point of history (LocalStorage `van-history`, 72 h).
export interface Sample {
  t: number; // epoch ms
  soc: number | null;
  batV: number | null;
  batA: number | null;
  cellMinV: number | null;
  cellMaxV: number | null;
  tempC: number | null;
  pvW: number | null;
  chgA: number | null;
  loadA: number | null;
  yieldWh: number | null;
  state: string | null;
}

// What the Van Power view renders — plain JSON so useCachedPromise can
// persist it, no secrets.
export interface VanView {
  reading: VanReading;
  samples: Sample[];
}
