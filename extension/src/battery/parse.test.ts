import { describe, it, expect } from "vitest";
import {
  parseBattStatus,
  parseIoregBattery,
  parsePauseUntil,
  batteryHealthPercent,
} from "./parse";

const BATT_JSON = JSON.stringify({
  charging: { allowCharging: true, useAdapter: true, pluggedIn: false },
  battery: {
    currentChargePercent: 76,
    state: "discharging",
    timeToLimitMinutes: null,
    fullCapacityMah: 8694,
    chargeRateWatts: -7,
    voltageVolts: 12.23,
  },
  configuration: {
    enabled: true,
    upperLimitPercent: 80,
    lowerLimitPercent: 100,
  },
  calibration: { phase: "Idle" },
});

// Trimmed from a real `ioreg -rn AppleSmartBattery` tree — the parser only
// looks at these four top-level keys, so the rest is omitted.
const IOREG_TEXT = `
+-o AppleSmartBattery  <class AppleSmartBattery>
    {
      "CurrentCapacity" = 94
      "NominalChargeCapacity" = 7699
      "MaxCapacity" = 100
      "Temperature" = 2999
      "DesignCapacity" = 8694
      "CycleCount" = 348
      "AppleRawMaxCapacity" = 7455
      "BatteryData" = {"Ra03"=74,"CycleCount"=999}
    }
`;

describe("parseBattStatus", () => {
  it("parses the batt status --json shape", () => {
    const status = parseBattStatus(BATT_JSON);
    expect(status.battery.currentChargePercent).toBe(76);
    expect(status.configuration.upperLimitPercent).toBe(80);
  });
});

describe("parseIoregBattery", () => {
  it("extracts the four top-level keys, ignoring the nested BatteryData copy", () => {
    const info = parseIoregBattery(IOREG_TEXT);
    expect(info).toEqual({
      cycleCount: 348,
      designCapacityMah: 8694,
      rawMaxCapacityMah: 7455,
      temperatureCelsius: 29.99,
    });
  });

  it("returns null when a key is missing", () => {
    expect(parseIoregBattery("no battery data here")).toBeNull();
  });
});

describe("parsePauseUntil", () => {
  it("parses a positive unix-seconds value", () => {
    expect(parsePauseUntil("1790497331\n")).toBe(1790497331);
  });

  it("returns null for missing, empty, zero, or garbage input", () => {
    expect(parsePauseUntil(null)).toBeNull();
    expect(parsePauseUntil("")).toBeNull();
    expect(parsePauseUntil("0")).toBeNull();
    expect(parsePauseUntil("not-a-number")).toBeNull();
  });
});

describe("batteryHealthPercent", () => {
  it("computes raw-max / design-capacity as a rounded percent", () => {
    expect(
      batteryHealthPercent({
        cycleCount: 1,
        designCapacityMah: 8694,
        rawMaxCapacityMah: 7455,
        temperatureCelsius: 30,
      }),
    ).toBe(86);
  });
});
