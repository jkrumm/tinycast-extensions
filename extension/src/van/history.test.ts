import { describe, expect, it } from "vitest";
import {
  DEDUPE_MS,
  HISTORY_WINDOW_MS,
  VICTRON_HISTORY_TTL_MS,
  appendSample,
  hasRequiredTrends,
  compactTrends,
  newestTrendSample,
  solarPoints,
  hasChartHistory,
  recentSamples,
  timeToFullOrEmpty,
  victronHistoryDue,
} from "./history";
import { fixtureSamples, fixtureVictronAll } from "./fixtures";
import { Sample } from "./types";

const NOW = 1_700_000_000_000;

function sample(t: number, soc: number | null = 50): Sample {
  return {
    t,
    soc,
    batV: null,
    batA: null,
    cellMinV: null,
    cellMaxV: null,
    tempC: null,
    pvW: null,
    chgA: null,
    loadA: null,
    yieldWh: null,
    state: null,
  };
}

describe("appendSample", () => {
  it("appends in order and drops anything older than 72 h", () => {
    const old = sample(NOW - HISTORY_WINDOW_MS - 1);
    const kept = sample(NOW - HISTORY_WINDOW_MS + 1);
    const next = appendSample([old, kept], sample(NOW));
    expect(next.map((s) => s.t)).toEqual([kept.t, NOW]);
  });

  it("replaces a sample closer than 2 min instead of stacking points", () => {
    const first = sample(NOW, 40);
    const next = appendSample([first], sample(NOW + DEDUPE_MS - 1, 41));
    expect(next).toHaveLength(1);
    expect(next[0].soc).toBe(41);
  });

  it("keeps samples 2 min or more apart", () => {
    const next = appendSample([sample(NOW)], sample(NOW + DEDUPE_MS));
    expect(next).toHaveLength(2);
  });
});

describe("recentSamples / hasChartHistory", () => {
  it("needs at least 6 samples inside the 72 h window", () => {
    const five = fixtureSamples(NOW, 5);
    const six = fixtureSamples(NOW, 6);
    expect(hasChartHistory(five, NOW)).toBe(false);
    expect(hasChartHistory(six, NOW)).toBe(true);
  });

  it("ignores samples outside the window", () => {
    const stale = Array.from({ length: 8 }, (_, i) =>
      sample(NOW - HISTORY_WINDOW_MS - (i + 1) * 60_000),
    );
    expect(recentSamples(stale, NOW)).toEqual([]);
    expect(hasChartHistory(stale, NOW)).toBe(false);
  });
});

describe("timeToFullOrEmpty", () => {
  const capacityAh = 200;

  it("estimates time to full while charging", () => {
    expect(timeToFullOrEmpty({ soc: 80, capacityAh, batA: 8 })).toEqual({
      direction: "full",
      hours: 5,
    });
  });

  it("estimates time to empty while discharging", () => {
    expect(timeToFullOrEmpty({ soc: 62, capacityAh, batA: -4 })).toEqual({
      direction: "empty",
      hours: 31,
    });
  });

  it("is null when idle, full, empty or inputs are missing", () => {
    expect(timeToFullOrEmpty({ soc: 50, capacityAh, batA: 0.1 })).toBeNull();
    expect(timeToFullOrEmpty({ soc: 100, capacityAh, batA: 5 })).toBeNull();
    expect(timeToFullOrEmpty({ soc: 0, capacityAh, batA: -5 })).toBeNull();
    expect(timeToFullOrEmpty({ soc: null, capacityAh, batA: 5 })).toBeNull();
    expect(
      timeToFullOrEmpty({ soc: 50, capacityAh: null, batA: 5 }),
    ).toBeNull();
    expect(timeToFullOrEmpty({ soc: 50, capacityAh, batA: null })).toBeNull();
  });
});

describe("victronHistoryDue (the daily history only)", () => {
  const noon = new Date(2026, 9, 5, 12, 0).getTime();
  const cache = (historyAt: number | null, withHistory = true) => ({
    attemptedAt: historyAt ?? noon,
    ok: true,
    updatedAt: historyAt,
    historyAt,
    history: withHistory ? fixtureVictronAll(noon).history : null,
    trends: null,
  });

  it("is due with nothing cached or no history in the cache", () => {
    expect(victronHistoryDue(null, noon)).toBe(true);
    expect(victronHistoryDue(cache(noon - 60_000, false), noon)).toBe(true);
    expect(victronHistoryDue(cache(null), noon)).toBe(true);
  });

  it("waits an hour after reading it", () => {
    const read = noon - 60_000;
    expect(victronHistoryDue(cache(read), noon)).toBe(false);
    expect(
      victronHistoryDue(cache(read), read + VICTRON_HISTORY_TTL_MS - 1),
    ).toBe(false);
    expect(victronHistoryDue(cache(read), read + VICTRON_HISTORY_TTL_MS)).toBe(
      true,
    );
  });

  it("expires at local midnight: yesterday's 'today' would be a day off", () => {
    const late = new Date(2026, 9, 5, 23, 50).getTime();
    const after = new Date(2026, 9, 6, 0, 5).getTime();
    expect(victronHistoryDue(cache(late), after)).toBe(true);
  });
});

describe("trend cache helpers (real capture)", () => {
  const all = fixtureVictronAll(NOW);
  const compact = compactTrends(all.trends)!;

  it("compactTrends keeps only PV power, battery V and A (and PV V when pushed), rounded, at native resolution", () => {
    expect(compact.trends.map((t) => t.vreg).sort()).toEqual([
      0xec8a, 0xed8d, 0xed8f,
    ]);
    expect(hasRequiredTrends(compact)).toBe(true);
    expect(
      hasRequiredTrends({
        ...compact,
        trends: compact.trends.filter((t) => t.vreg !== 0xed8f),
      }),
    ).toBe(false);
    expect(hasRequiredTrends(null)).toBe(false);
    for (const trend of compact.trends) {
      expect(trend.samples.length).toBeGreaterThan(200);
      expect(trend.segments.length).toBeGreaterThan(0); // mergeTrends needs the steps
    }
    const volts = compact.trends.find((t) => t.vreg === 0xed8d)!;
    for (const { v } of volts.samples) {
      if (v !== null) expect(Math.round(v * 100)).toBeCloseTo(v * 100, 6);
    }
    expect(JSON.stringify(compact).length).toBeLessThan(70_000);
    expect(compactTrends(null)).toBeNull();
  });

  it("newestTrendSample is the lagging series' newest sample", () => {
    expect(newestTrendSample(null)).toBeUndefined();
    const lagging = {
      ...compact,
      trends: compact.trends.map((t, i) =>
        i === 0 ? { ...t, samples: t.samples.slice(0, -5) } : t,
      ),
    };
    expect(newestTrendSample(lagging)).toBe(
      Math.min(...lagging.trends.map((t) => t.samples.at(-1)!.t)),
    );
  });

  it("solarPoints: 10-minute buckets of whole watts, oldest first", () => {
    const solar = solarPoints(compact);
    expect(solar.length).toBeGreaterThan(100);
    expect(solar.length).toBeLessThan(
      all.trends!.trends.find((t) => t.vreg === 0xec8a)!.samples.length,
    );
    expect(solar.every(([, w]) => Number.isInteger(w))).toBe(true);
    expect(solar.map(([t]) => t)).toEqual(
      [...solar.map(([t]) => t)].sort((a, b) => a - b),
    );
    expect(solarPoints(null)).toEqual([]);
  });
});
