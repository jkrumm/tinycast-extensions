import { describe, it, expect } from "vitest";
import { aggregateSpend } from "./aggregate";
import { TimeseriesResponse } from "./types";

const FIXTURE: TimeseriesResponse = {
  groupKeys: ["claude-code", "codex"],
  buckets: [
    { bucket: "2026-09-20", groups: { "claude-code": 1.2, codex: 0.3 } },
    { bucket: "2026-09-21", groups: { "claude-code": 2.5, codex: null } },
    { bucket: "2026-09-22", groups: { "claude-code": 0, codex: 0.1 } },
    { bucket: "2026-09-23", groups: { "claude-code": 3.1, codex: 0.4 } },
    { bucket: "2026-09-24", groups: { "claude-code": 1.9, codex: 0.2 } },
    { bucket: "2026-09-25", groups: { "claude-code": 2.2, codex: 0.15 } },
    { bucket: "2026-09-26", groups: { "claude-code": 4.4, codex: 0.6 } },
  ],
};

describe("aggregateSpend", () => {
  it("treats the last bucket as today", () => {
    const result = aggregateSpend(FIXTURE);
    expect(result.today).toEqual({ "claude-code": 4.4, codex: 0.6 });
    expect(result.todayTotal).toBeCloseTo(5.0, 5);
  });

  it("keeps only lanes that spent today, most expensive first", () => {
    const fixture: TimeseriesResponse = {
      groupKeys: ["claude-code", "codex", "fleet", "idle"],
      buckets: [
        {
          bucket: "2026-09-26",
          groups: { "claude-code": 1, codex: null, fleet: 3, idle: 0 },
        },
      ],
    };
    const result = aggregateSpend(fixture);
    expect(Object.entries(result.today)).toEqual([
      ["fleet", 3],
      ["claude-code", 1],
    ]);
  });

  it("sums every bucket's groups (nulls as 0) for the 7-day total", () => {
    const result = aggregateSpend(FIXTURE);
    const expected =
      1.2 +
      0.3 +
      2.5 +
      0 +
      0 +
      0.1 +
      3.1 +
      0.4 +
      1.9 +
      0.2 +
      2.2 +
      0.15 +
      4.4 +
      0.6;
    expect(result.sevenDayTotal).toBeCloseTo(expected, 5);
  });

  it("returns an empty today when buckets are empty", () => {
    const empty: TimeseriesResponse = {
      groupKeys: ["claude-code"],
      buckets: [],
    };
    const result = aggregateSpend(empty);
    expect(result.today).toEqual({});
    expect(result.todayTotal).toBe(0);
    expect(result.sevenDayTotal).toBe(0);
  });
});
