// Shape of `batt status --json` (https://github.com/charlie0129/batt) — only
// the fields this command reads; the real output carries more.
export interface BattStatus {
  charging: {
    allowCharging: boolean;
    useAdapter: boolean;
    pluggedIn: boolean;
  };
  battery: {
    currentChargePercent: number;
    state: string; // "charging" | "discharging" | ...
    timeToLimitMinutes: number | null;
    fullCapacityMah: number;
    chargeRateWatts: number;
    voltageVolts: number;
  };
  configuration: {
    enabled: boolean;
    upperLimitPercent: number;
    lowerLimitPercent: number;
  };
  calibration: {
    phase: string;
  };
}

// A handful of top-level `ioreg -arn AppleSmartBattery` keys, read via
// regex rather than `plutil -convert json` — a couple of unrelated fields in
// the real device tree (huge unsigned integers) make plutil's JSON
// conversion fail outright, so a targeted regex on the known keys is both
// simpler and more robust. Confirmed present, top-level, on this MacBook.
export interface HardwareBatteryInfo {
  cycleCount: number;
  designCapacityMah: number;
  rawMaxCapacityMah: number; // AppleRawMaxCapacity
  temperatureCelsius: number; // ioreg reports centi-Celsius
}

export interface BatterySnapshot {
  status: BattStatus;
  hardware: HardwareBatteryInfo | null;
  pauseUntilEpoch: number | null; // ~/.config/batt/pause-until, unix seconds
}
