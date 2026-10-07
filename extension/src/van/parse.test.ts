import { describe, expect, it } from "vitest";
import {
  parseEctiveFrame,
  parseHelperOutput,
  parseVictronSolar,
  toReading,
  toSample,
} from "./parse";
import {
  ECTIVE_FRAME_HEX,
  HELPER_BATTERY_BUSY,
  HELPER_BLUETOOTH_OFF,
  HELPER_FULL,
  HELPER_NO_KEY,
  VICTRON_DECRYPTED_HEX,
} from "./fixtures";

describe("parseEctiveFrame", () => {
  it("decodes the syssi/esphome-topband-bms Ective test frame", () => {
    const r = parseEctiveFrame(ECTIVE_FRAME_HEX)!;
    expect(r.packVoltageV).toBeCloseTo(13.7, 3);
    expect(r.cellSumV).toBeCloseTo(13.714, 3);
    expect(r.currentA).toBeCloseTo(-12.808, 3);
    expect(r.capacityAh).toBeCloseTo(194.86, 2);
    expect(r.cycles).toBe(407);
    expect(r.soc).toBe(98);
    expect(r.tempC).toBeCloseTo(30.95, 2);
    expect(r.errorMask).toBe(0);
    expect(r.errorFlags).toEqual([]);
    expect(r.cellsMv).toEqual([3422, 3441, 3429, 3422]);
  });

  it("rejects a corrupted payload (CRC), wrong length and a bad start byte", () => {
    const corrupted = ECTIVE_FRAME_HEX.replace("3834", "3835");
    expect(corrupted).not.toBe(ECTIVE_FRAME_HEX);
    expect(parseEctiveFrame(corrupted)).toBeNull();
    expect(parseEctiveFrame(ECTIVE_FRAME_HEX.slice(0, -2))).toBeNull();
    expect(parseEctiveFrame(`00${ECTIVE_FRAME_HEX.slice(2)}`)).toBeNull();
    expect(parseEctiveFrame("zz")).toBeNull();
  });

  it("names the set error bits", () => {
    // d[18] error mask 0x0041 = charge over-temp + under-voltage; re-sum the CRC.
    const d = Buffer.from(
      Buffer.from(ECTIVE_FRAME_HEX, "hex").subarray(1).toString("latin1"),
      "hex",
    );
    d[18] = 0x41;
    let sum = 0;
    for (let i = 0; i < 54; i++) sum += d[i];
    d.writeUInt16BE(sum & 0xffff, 54);
    const frame = `5e${Buffer.from(d.toString("hex").toUpperCase()).toString("hex")}`;
    expect(parseEctiveFrame(frame)!.errorFlags).toEqual([
      "Charge over-temp",
      "Under-voltage",
    ]);
  });
});

describe("parseVictronSolar", () => {
  it("decodes the victron-ble end-to-end vector (Absorption, 13.88 V, 19 W)", () => {
    expect(parseVictronSolar(VICTRON_DECRYPTED_HEX)).toEqual({
      chargeState: 4,
      stateLabel: "Absorption",
      chargerError: 0,
      batteryV: 13.88,
      chargeA: 1.4,
      yieldWh: 30,
      solarW: 19,
      loadA: 0,
    });
  });

  it("decodes the 16-byte vectors incl. trailing padding", () => {
    const bulk = parseVictronSolar("0300f80402000200030000fe8c9a5572")!;
    expect(bulk.stateLabel).toBe("Bulk");
    const mppt100 = parseVictronSolar("0300fb09650032000901ffff31bc45ad")!;
    expect(mppt100).toMatchObject({
      chargeA: 10.1,
      batteryV: 25.55,
      solarW: 265,
      yieldWh: 500,
      loadA: null, // 0x1FF = not available
    });
  });

  it("maps NA sentinels to null and rejects short data", () => {
    const na = parseVictronSolar("ffffff7fff7fffffffffff01")!;
    expect(na).toMatchObject({
      chargeState: null,
      stateLabel: null,
      chargerError: null,
      batteryV: null,
      chargeA: null,
      yieldWh: null,
      solarW: null,
      loadA: null,
    });
    expect(parseVictronSolar("0400")).toBeNull();
  });
});

describe("parseHelperOutput", () => {
  it("parses the last JSON line and defaults errors", () => {
    const out = parseHelperOutput(
      `noise\n${JSON.stringify({ battery: null, victron: null })}\n`,
    );
    expect(out).toEqual({ battery: null, victron: null, errors: [] });
  });

  it("throws on empty or malformed output", () => {
    expect(() => parseHelperOutput("")).toThrow();
    expect(() => parseHelperOutput("not json")).toThrow();
    expect(() =>
      parseHelperOutput(JSON.stringify({ battery: { name: "x" } })),
    ).toThrow();
  });
});

describe("toReading", () => {
  const now = 1_700_000_000_000;

  it("combines both devices without issues", () => {
    const r = toReading({ helper: HELPER_FULL, keyMissing: false, now });
    expect(r.issues).toEqual([]);
    expect(r.battery?.soc).toBe(98);
    expect(r.solar?.solarW).toBe(19);
  });

  it("says the Victron key is missing but keeps the battery", () => {
    const r = toReading({ helper: HELPER_NO_KEY, keyMissing: true, now });
    expect(r.battery?.soc).toBe(98);
    expect(r.solar).toBeNull();
    expect(r.issues).toEqual([expect.stringContaining("make secrets")]);
  });

  it("reports a key mismatch, a busy BMS and Bluetooth off", () => {
    const mismatch = toReading({
      helper: {
        ...HELPER_FULL,
        victron: {
          ...HELPER_FULL.victron!,
          decryptedHex: null,
          keyMismatch: true,
        },
      },
      keyMissing: false,
      now,
    });
    expect(mismatch.issues[0]).toContain("key mismatch");

    const busy = toReading({
      helper: HELPER_BATTERY_BUSY,
      keyMissing: true,
      now,
    });
    expect(busy.battery).toBeNull();
    expect(busy.issues[0]).toContain("phone app");

    const off = toReading({
      helper: HELPER_BLUETOOTH_OFF,
      keyMissing: false,
      now,
    });
    expect(off.issues).toEqual(["Bluetooth is off."]);
  });
});

describe("toSample", () => {
  it("flattens a full reading, preferring the cell sum for pack voltage", () => {
    const reading = toReading({
      helper: HELPER_FULL,
      keyMissing: false,
      now: 1_700_000_000_000,
    });
    expect(toSample(reading)).toEqual({
      t: 1_700_000_000_000,
      soc: 98,
      batV: 13.714,
      batA: -12.808,
      cellMinV: 3.422,
      cellMaxV: 3.441,
      tempC: 30.95,
      pvW: 19,
      chgA: 1.4,
      loadA: 0,
      yieldWh: 30,
      state: "Absorption",
    });
  });

  it("nulls what was not read", () => {
    const reading = toReading({
      helper: HELPER_BATTERY_BUSY,
      keyMissing: false,
      now: 5,
    });
    const sample = toSample(reading);
    expect(sample.soc).toBeNull();
    expect(sample.batA).toBeNull();
  });
});
