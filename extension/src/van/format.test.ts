import { describe, expect, it } from "vitest";
import {
  batteryWarnings,
  formatAmps,
  formatEta,
  formatYield,
  tileStatus,
} from "./format";
import { HELPER_FULL } from "./fixtures";
import { toReading } from "./parse";

const now = 1_700_000_000_000;

describe("format helpers", () => {
  it("formats signed amps with a real minus and no -0.0", () => {
    expect(formatAmps(8.44)).toBe("+8.4 A");
    expect(formatAmps(-5.1)).toBe("−5.1 A");
    expect(formatAmps(-0.02)).toBe("0.0 A");
  });

  it("formats ETAs and yield", () => {
    expect(formatEta(0.4)).toBe("~24 min");
    expect(formatEta(3.2)).toBe("~3h");
    expect(formatEta(31)).toBe("~31h");
    expect(formatEta(96)).toBe("~4 d");
    expect(formatEta(24 * 40)).toBe(">14 d");
    expect(formatYield(420)).toBe("420 Wh");
    expect(formatYield(1240)).toBe("1.24 kWh");
  });
});

describe("tileStatus", () => {
  it("fits the hub tile in 18 characters", () => {
    const status = tileStatus({
      t: now,
      soc: 82,
      batA: 8.4,
      batV: null,
      cellMinV: null,
      cellMaxV: null,
      tempC: null,
      pvW: null,
      chgA: null,
      loadA: null,
      yieldWh: null,
      state: null,
    });
    expect(status).toBe("82% · +8.4A");
    expect(status.length).toBeLessThanOrEqual(18);
    expect(tileStatus(undefined)).toBe("No reading yet");
  });
});

describe("batteryWarnings", () => {
  const reading = toReading({ helper: HELPER_FULL, keyMissing: false, now });
  const withBattery = (
    patch: Partial<NonNullable<typeof reading.battery>>,
  ) => ({
    ...reading,
    battery: { ...reading.battery!, ...patch },
  });

  it("is silent for a healthy pack", () => {
    expect(batteryWarnings(reading)).toEqual([]);
    expect(batteryWarnings({ ...reading, battery: null })).toEqual([]);
  });

  it("warns on a cell spread from 50 mV mid-charge (20–90 %), not below", () => {
    const mid = { soc: 60 };
    expect(
      batteryWarnings(withBattery({ ...mid, cellsMv: [3400, 3449] })),
    ).toEqual([]);
    const [warning] = batteryWarnings(
      withBattery({ ...mid, cellsMv: [3400, 3452] }),
    );
    expect(warning).toContain("Cell spread 52 mV");
    expect(
      batteryWarnings(withBattery({ soc: 20, cellsMv: [3400, 3450] })),
    ).toHaveLength(1);
    expect(
      batteryWarnings(withBattery({ soc: 90, cellsMv: [3400, 3450] })),
    ).toHaveLength(1);
  });

  it("stays quiet at the ends of the charge curve until the spread reaches 100 mV", () => {
    for (const soc of [99, 91, 19, 5]) {
      expect(
        batteryWarnings(withBattery({ soc, cellsMv: [3400, 3450] })),
      ).toEqual([]);
      expect(
        batteryWarnings(withBattery({ soc, cellsMv: [3400, 3499] })),
      ).toEqual([]);
      expect(
        batteryWarnings(withBattery({ soc, cellsMv: [3400, 3500] }))[0],
      ).toContain("Cell spread 100 mV");
    }
  });

  it("warns near freezing or hot, not in the comfortable range", () => {
    expect(batteryWarnings(withBattery({ tempC: 5 }))).toEqual([]);
    expect(batteryWarnings(withBattery({ tempC: 40 }))).toEqual([]);
    expect(batteryWarnings(withBattery({ tempC: 3.14 }))[0]).toContain(
      "3.1 °C",
    );
    expect(batteryWarnings(withBattery({ tempC: 41 }))[0]).toContain("41.0 °C");
  });
});
