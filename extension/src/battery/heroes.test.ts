import { describe, expect, it } from "vitest";
import { metricCards, panelColumns } from "./heroes";
import { BatterySnapshot } from "./types";

function snapshot(
  overrides: {
    state?: string;
    pluggedIn?: boolean;
    useAdapter?: boolean;
    limited?: boolean;
    hardware?: boolean;
  } = {},
): BatterySnapshot {
  const {
    state = "charging",
    pluggedIn = true,
    useAdapter = true,
    limited = true,
    hardware = true,
  } = overrides;
  return {
    status: {
      charging: { allowCharging: true, useAdapter, pluggedIn },
      battery: {
        currentChargePercent: 76,
        state,
        timeToLimitMinutes: null,
        fullCapacityMah: 6000,
        chargeRateWatts: 12,
        voltageVolts: 12.234,
      },
      configuration: {
        enabled: limited,
        upperLimitPercent: 80,
        lowerLimitPercent: 75,
      },
      calibration: { phase: "" },
    },
    hardware: hardware
      ? {
          cycleCount: 300,
          designCapacityMah: 6000,
          rawMaxCapacityMah: 5000,
          temperatureCelsius: 29.99,
        }
      : null,
    pauseUntilEpoch: null,
  };
}

describe("battery panel", () => {
  it("charge with its state, watts and limit; health with the cycle count", () => {
    const [charge, health] = panelColumns(snapshot());
    expect(charge).toMatchObject({
      label: "Charge",
      value: 76,
      gauge: "battery",
      marker: 80,
      sub: "Charging · 12.0 W · limit 80%",
    });
    expect(health).toMatchObject({
      label: "Health",
      value: 83,
      sub: "300 cycles",
    });
  });

  it("no limit marker without a limit, no health without ioreg data", () => {
    const columns = panelColumns(
      snapshot({ state: "discharging", limited: false, hardware: false }),
    );
    expect(columns).toHaveLength(1);
    expect(columns[0].marker).toBeUndefined();
    expect(columns[0].sub).toBe("Discharging · 12.0 W");
  });
});

describe("battery metrics row", () => {
  it("voltage, temperature and the adapter", () => {
    expect(metricCards(snapshot())).toEqual([
      { label: "Voltage", value: "12.23", unit: "V" },
      { label: "Temperature", value: "30.0", unit: "°C" },
      { label: "Adapter", value: "Plugged in", tone: undefined },
    ]);
  });

  it("on battery, and without ioreg data no temperature", () => {
    const cards = metricCards(snapshot({ pluggedIn: false, hardware: false }));
    expect(cards.map((c) => c.label)).toEqual(["Voltage", "Adapter"]);
    expect(cards[1]).toMatchObject({ value: "On battery" });
  });

  it("flags a plugged-in adapter that is not allowed to charge", () => {
    expect(metricCards(snapshot({ useAdapter: false })).at(-1)).toMatchObject({
      value: "Blocked",
      tone: "warn",
    });
  });
});
