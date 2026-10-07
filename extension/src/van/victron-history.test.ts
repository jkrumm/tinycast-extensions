import { describe, expect, it } from "vitest";
import {
  parseHistoryOutput,
  parseVictronDay,
  parseVictronTotal,
} from "./victron-history";

// patlux/ve-smart-telemetry fixtures/protocol — captured 34 B payloads.
const DAY_1050 =
  "009400000000000000a20a7009000000000053038200000012020000bf0079135c00";
const TOTAL_104F =
  "010012000000f7dc0100f7dc01006b14e80a1e0100" + "ff".repeat(13);

// Local noon, so a ±1 h DST change can never move the calendar day.
const NOW = new Date(2026, 9, 5, 12, 0, 0);

const dayHex = (patch: Record<number, number[]> = {}): string => {
  const bytes = Array.from(Buffer.from(DAY_1050, "hex"));
  for (const [offset, values] of Object.entries(patch)) {
    values.forEach((v, i) => (bytes[Number(offset) + i] = v));
  }
  return Buffer.from(bytes).toString("hex");
};

describe("parseVictronDay", () => {
  it("decodes the captured 0x1050 record", () => {
    expect(parseVictronDay(DAY_1050, 0x1050, NOW)).toEqual({
      vreg: 0x1050,
      date: "2026-10-05",
      yieldWh: 1480,
      consumedWh: 0,
      battVMax: 27.22,
      battVMin: 24.16,
      bulkMin: 851,
      absMin: 130,
      floatMin: 0,
      maxPowerW: 530,
      maxBattA: 19.1,
      maxPvV: 49.85,
      seq: 92,
      errors: [],
    });
  });

  it("dates N days back from the register, across a month boundary", () => {
    expect(parseVictronDay(DAY_1050, 0x1051, NOW)?.date).toBe("2026-10-04");
    expect(parseVictronDay(DAY_1050, 0x1050 + 5, NOW)?.date).toBe("2026-09-30");
    expect(parseVictronDay(DAY_1050, 0x106e, NOW)?.date).toBe("2026-09-05");
    expect(parseVictronDay(DAY_1050, 0x1051, NOW.getTime())?.date).toBe(
      "2026-10-04",
    );
  });

  it("dates correctly over a DST change", () => {
    // Europe/Berlin falls back on 2026-10-25; a 24 h-multiple subtraction would drift.
    const after = new Date(2026, 9, 26, 0, 30, 0);
    expect(parseVictronDay(DAY_1050, 0x1051, after)?.date).toBe("2026-10-25");
    expect(parseVictronDay(DAY_1050, 0x1052, after)?.date).toBe("2026-10-24");
  });

  it("maps the 0xFFFFFFFF consumed sentinel to null", () => {
    const r = parseVictronDay(
      dayHex({ 5: [0xff, 0xff, 0xff, 0xff] }),
      0x1050,
      NOW,
    )!;
    expect(r.consumedWh).toBeNull();
    expect(
      parseVictronDay(dayHex({ 5: [0x64, 0, 0, 0] }), 0x1050, NOW)!.consumedWh,
    ).toBe(1000);
  });

  it("returns non-zero error codes, most recent first", () => {
    expect(
      parseVictronDay(dayHex({ 14: [0, 2, 0, 17] }), 0x1050, NOW)!.errors,
    ).toEqual([2, 17]);
  });

  it("decodes full-range unsigned values without sign overflow", () => {
    const r = parseVictronDay(
      dayHex({ 1: [0xfe, 0xff, 0xff, 0xff], 24: [0xff, 0xff, 0xff, 0xff] }),
      0x1050,
      NOW,
    )!;
    expect(r.yieldWh).toBe(0xfffffffe * 10);
    expect(r.maxPowerW).toBe(0xffffffff);
  });

  it("skips empty, short, long, non-hex payloads and out-of-range registers", () => {
    expect(parseVictronDay("", 0x1050, NOW)).toBeNull();
    expect(parseVictronDay(DAY_1050.slice(0, -2), 0x1050, NOW)).toBeNull();
    expect(parseVictronDay(`${DAY_1050}00`, 0x1050, NOW)).toBeNull();
    expect(parseVictronDay("zz".repeat(34), 0x1050, NOW)).toBeNull();
    expect(parseVictronDay(DAY_1050, 0x104f, NOW)).toBeNull();
    expect(parseVictronDay(DAY_1050, 0x106f, NOW)).toBeNull();
    expect(parseVictronDay(DAY_1050, 0x1030, NOW)).toBeNull();
  });
});

describe("parseVictronTotal", () => {
  it("decodes the captured 0x104F record", () => {
    expect(parseVictronTotal(TOTAL_104F)).toEqual({
      userYieldKwh: 1221.03,
      systemYieldKwh: 1221.03,
      maxPvV: 52.27,
      battVMax: 27.92,
      battVMin: 0.01,
      daysAvailable: 30,
      errors: [0x12],
    });
  });

  it("accepts the 19-byte firmware 1.16 layout without a battery minimum", () => {
    const r = parseVictronTotal(TOTAL_104F.slice(0, 38))!;
    expect(r.daysAvailable).toBe(30);
    expect(r.battVMin).toBeNull();
  });

  it("returns null for an empty or too-short payload", () => {
    expect(parseVictronTotal("")).toBeNull();
    expect(parseVictronTotal(TOTAL_104F.slice(0, 36))).toBeNull();
    expect(parseVictronTotal("xyz")).toBeNull();
  });
});

describe("parseHistoryOutput", () => {
  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

  it("decodes a full helper result, days newest first", () => {
    const r = parseHistoryOutput(
      line({
        victronHistory: {
          totalHex: TOTAL_104F,
          days: [
            { vreg: 0x1051, hex: DAY_1050 },
            { vreg: 0x1050, hex: DAY_1050 },
          ],
        },
        errors: [],
      }),
      NOW,
    );
    expect(r.total?.daysAvailable).toBe(30);
    expect(r.days.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-04"]);
    expect(r.errors).toEqual([]);
  });

  it("keeps the readable days when one record is unreadable", () => {
    const r = parseHistoryOutput(
      line({
        victronHistory: {
          totalHex: TOTAL_104F,
          days: [
            { vreg: 0x1050, hex: DAY_1050 },
            { vreg: 0x1051, hex: "" },
          ],
        },
        errors: ["victron-reply-timeout"],
      }),
      NOW,
    );
    expect(r.days).toHaveLength(1);
    expect(r.errors).toEqual(["victron-reply-timeout"]);
  });

  it("reports a failed session as errors with no data", () => {
    const r = parseHistoryOutput(
      line({ victronHistory: null, errors: ["victron-pairing-timeout"] }),
    );
    expect(r).toEqual({
      total: null,
      days: [],
      errors: ["victron-pairing-timeout"],
    });
  });

  it("handles a missing total and takes the last stdout line", () => {
    const r = parseHistoryOutput(
      `noise\n${line({ victronHistory: { totalHex: null, days: [] }, errors: [] })}`,
    );
    expect(r.total).toBeNull();
    expect(r.days).toEqual([]);
  });

  it("throws on output that is not the contract", () => {
    expect(() => parseHistoryOutput("")).toThrow("printed nothing");
    expect(() => parseHistoryOutput("42")).toThrow("unexpected value");
    expect(() => parseHistoryOutput("not json")).toThrow();
    expect(() =>
      parseHistoryOutput(
        line({ victronHistory: { totalHex: null }, errors: [] }),
      ),
    ).toThrow("malformed");
  });
});
