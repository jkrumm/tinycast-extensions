import { describe, expect, it } from "vitest";
import { evaluate, toCaptures } from "./soc-eval";
import { intervalLoads } from "./soc-estimate";
import { CaptureLogEntry } from "./capture-log";
import { simulateVan } from "./fixtures";
import { defaultLocation } from "./sun";

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 5, 12, 0).getTime();
const FROM = NOW - 5 * 24 * HOUR;
const van = simulateVan({
  from: FROM,
  to: NOW,
  loadA: 1,
  capacityAh: 100,
  sunA: 8,
});

// Readings the way the app would have logged them: the exact charge and net
// current from the simulation, and an `estimateAtT` that is a few % off.
const log = (
  hoursFromStart: number,
  logged: number | null = null,
): CaptureLogEntry => {
  const t = FROM + hoursFromStart * HOUR;
  return {
    t,
    ective: {
      soc: Math.round(van.truthAt(t)),
      currentA: van.chargeAAt(t) - 1,
      voltageV: 13.3,
      capacityAh: 100,
      tempC: 20,
    },
    victron: null,
    estimateAtT: logged,
  };
};
const entries = [10, 20, 30, 41, 52, 61, 70, 80, 93].map((h) => log(h, 0));
const report = evaluate({
  entries: entries.map((e) => ({
    ...e,
    estimateAtT: Math.round(van.truthAt(e.t)) - 4,
    estimateReason: null,
  })),
  trends: van.trends,
  location: (t) => defaultLocation(t),
});

describe("evaluate (leave-one-out on a simulated van)", () => {
  it("one row per reading, with measured, predicted without it, and the error", () => {
    expect(report.rows).toHaveLength(entries.length);
    for (const row of report.rows) {
      expect(row.predicted).not.toBeNull();
      expect(row.error).toBeCloseTo(row.predicted! - row.measured, 6);
    }
  });

  it("the held-out prediction is close when the load is recoverable from the other readings", () => {
    expect(report.summary.n).toBe(entries.length);
    expect(report.summary.mae!).toBeLessThan(5);
    expect(report.summary.maxAbs!).toBeLessThan(12);
  });

  it("compares the logged live estimate too, and infers the load", () => {
    expect(report.summary.loggedN).toBe(entries.length);
    expect(report.summary.loggedMae).toBeCloseTo(4, 0);
    expect(report.rows[0].loggedError).toBe(-4);
    expect(report.loadA).toBeGreaterThanOrEqual(0);
  });

  it("knows the hours to the nearest other anchor and whether it was day or night", () => {
    for (const row of report.rows) {
      expect(row.hoursToAnchor).not.toBeNull();
      expect(row.hoursToAnchor!).toBeGreaterThan(0);
      expect(row.hoursToAnchor!).toBeLessThan(25);
    }
    const dark = (t: number) => {
      const d = new Date(t);
      return d.getHours() < 5 || d.getHours() >= 22; // unambiguous at 45° N
    };
    for (const row of report.rows) {
      if (dark(row.t)) expect(row.night).toBe(true);
    }
    expect(report.rows.some((r) => r.night)).toBe(true);
    expect(report.rows.some((r) => !r.night)).toBe(true);
  });

  it("lists the constants to tune", () => {
    expect(report.constants).toMatchObject({
      DEFAULT_LOAD_A: 0.6,
      FULL_VOLTS: 13.9,
      FULL_TAPER_C: 0.03,
    });
  });
});

describe("the live prediction in the report", () => {
  const mixed = [
    { ...entries[0], estimateAtT: 60, estimateReason: null },
    { ...entries[1], estimateAtT: null, estimateReason: "stale-trends" },
    { ...entries[2], estimateAtT: null, estimateReason: "no-estimate" },
    { ...entries[3], estimateAtT: 12 }, // written before the read-then-predict fix: no reason
  ];
  const r = evaluate({
    entries: mixed,
    trends: van.trends,
    location: (t) => defaultLocation(t),
  });

  it("counts only the entries with a real prediction, and says how many were left out and why", () => {
    expect(r.summary.loggedN).toBe(1);
    expect(r.summary.loggedSkipped).toBe(3);
    expect(r.summary.loggedSkippedReasons).toEqual({
      "stale-trends": 1,
      "no-estimate": 1,
      legacy: 1,
    });
    expect(r.rows.map((x) => x.loggedNote)).toEqual([
      null,
      "stale-trends",
      "no-estimate",
      "legacy",
    ]);
    expect(r.summary.loggedMae).toBe(Math.abs(60 - mixed[0].ective.soc));
  });
});

describe("implied load per interval between anchors", () => {
  it("between confirmed fulls it is the charge that went in over the hours — the load", () => {
    const intervals = intervalLoads({
      trends: van.trends,
      captures: [],
      from: FROM,
      to: NOW,
      capacityAh: 100,
    }).filter((i) => i.reliable);
    expect(intervals.length).toBeGreaterThan(1);
    for (const interval of intervals) {
      expect(interval.hours).toBeGreaterThan(2);
      expect(interval.loadA).toBeCloseTo(1.0, 0);
    }
  });

  it("the report carries one row per pair of consecutive anchors, readings included", () => {
    expect(report.intervals.length).toBeGreaterThanOrEqual(entries.length - 1);
    const reliable = report.intervals.filter(
      (i) => i.reliable && i.fromKind === "capture" && i.toKind === "capture",
    );
    expect(reliable.length).toBeGreaterThan(0);
    for (const i of reliable) expect(i.loadA).toBeCloseTo(1.0, 0);
  });
});

describe("degenerate input", () => {
  it("no readings: an empty report, no throw", () => {
    const empty = evaluate({
      entries: [],
      trends: null,
      location: defaultLocation,
    });
    expect(empty.rows).toEqual([]);
    expect(empty.summary).toMatchObject({ n: 0, mae: null, maxAbs: null });
    expect(empty.intervals).toEqual([]);
  });

  it("without trends nothing can be predicted, and says so with nulls", () => {
    const thin = evaluate({
      entries: entries.slice(0, 3),
      trends: null,
      location: defaultLocation,
    });
    expect(
      thin.rows.every((r) => r.predicted === null && r.error === null),
    ).toBe(true);
    expect(thin.summary.n).toBe(0);
    expect(toCaptures(entries.slice(0, 1))[0]).toMatchObject({
      netA: entries[0].ective.currentA,
    });
  });
});
