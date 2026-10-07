import { describe, expect, it } from "vitest";
import {
  TREND_WINDOW_MS,
  VictronTrends,
  decodeTrends,
  mergeTrends,
  parseAllOutput,
  parseTrendsOutput,
} from "./victron-trends";
import {
  TRENDS_CAPTURE as CAPTURE,
  TRENDS_INCREMENTAL,
} from "./victron-trends.fixture";

const byVreg = (vreg: number) =>
  decodeTrends(CAPTURE)?.trends.find((t) => t.vreg === vreg);
const iso = (ms: number): string => new Date(ms).toISOString();

describe("decodeTrends (real capture, subtrends 3 + 2 + 1 stitched)", () => {
  it("decodes the trends that have data", () => {
    expect(decodeTrends(CAPTURE)?.trends.map((t) => t.vreg)).toEqual([
      0xec89, 0xec8a, 0xed8d, 0xed8f,
    ]);
    expect(decodeTrends(CAPTURE)?.anchor).toEqual(CAPTURE.anchor);
  });

  it("covers 72 h as a 1800 s segment then a 300 s segment", () => {
    const battery = byVreg(0xed8d)!;
    expect(battery.samples).toHaveLength(404);
    expect(
      battery.segments.map((s) => [
        s.stepS,
        s.count,
        iso(s.fromMs),
        iso(s.toMs),
      ]),
    ).toEqual([
      [1800, 92, "2026-10-02T20:25:19.027Z", "2026-10-04T17:55:19.027Z"],
      [300, 312, "2026-10-04T18:05:19.027Z", "2026-10-05T20:00:19.027Z"],
    ]);
    const span = CAPTURE.anchor.unixMs - battery.samples[0].t;
    expect(span).toBeLessThanOrEqual(TREND_WINDOW_MS);
    expect(span).toBeGreaterThan(TREND_WINDOW_MS - 1800 * 1000);
  });

  it("is time-sorted with native spacing; the only gap is the 3→2 seam", () => {
    const { samples, segments } = byVreg(0xed8d)!;
    const gaps: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = samples[i].t - samples[i - 1].t;
      expect(dt).toBeGreaterThan(0);
      const step =
        segments.find(
          (s) => samples[i].t >= s.fromMs && samples[i].t <= s.toMs,
        )!.stepS * 1000;
      if (dt !== step) gaps.push(dt);
    }
    expect(gaps).toEqual([600_000]);
  });

  it("anchors times to the device clock reading, newest sample ~2 min old", () => {
    const last = byVreg(0xed8d)!.samples.at(-1)!;
    expect(CAPTURE.anchor.unixMs - last.t).toBeLessThan(300_000);
    expect(CAPTURE.anchor.unixMs - last.t).toBeGreaterThan(0);
  });

  it("rows from the last 2 h come from 30 s data averaged to 5 minutes", () => {
    const last = byVreg(0xed8d)!.samples.slice(-8);
    expect(last.map((s) => s.t - last[0].t)).toEqual([
      0, 300_000, 600_000, 900_000, 1_200_000, 1_500_000, 1_800_000, 2_100_000,
    ]);
    const expected = [13.223, 13.274, 13.3, 13.3, 13.282, 13.254, 13.25, 13.25];
    last.forEach((s, i) => expect(s.v).toBeCloseTo(expected[i], 3));
  });

  it("scales and bounds every channel plausibly", () => {
    const volts = byVreg(0xed8d)!.samples.map((s) => s.v!);
    expect(Math.min(...volts)).toBeGreaterThan(12.5);
    expect(Math.max(...volts)).toBeLessThan(14.5);
    const watts = byVreg(0xec8a)!.samples.map((s) => s.v!);
    expect(Math.max(...watts)).toBeGreaterThan(100);
    expect(Math.max(...watts)).toBeLessThan(400);
    const amps = byVreg(0xed8f)!.samples.map((s) => s.v!);
    expect(Math.max(...amps)).toBeGreaterThan(5);
    expect(Math.max(...amps)).toBeLessThan(30);
  });

  it("maps the not-available marker to null (an all-empty trend is kept short)", () => {
    const output = byVreg(0xec89)!;
    expect(output.samples).toHaveLength(56);
    expect(output.samples.every((s) => s.v === null)).toBe(true);
  });

  it("skips malformed replies and unusable vreg lists", () => {
    const broken = {
      ...CAPTURE,
      pushes: CAPTURE.pushes.map((p) => ({
        ...p,
        replies: p.replies.map((r) => r.slice(0, -2)),
      })),
    };
    expect(decodeTrends(broken)).toBeNull();
    expect(
      decodeTrends({ ...CAPTURE, supportedHex: "ffff".repeat(8) }),
    ).toBeNull();
    expect(decodeTrends({ ...CAPTURE, supportedHex: "00" })).toBeNull();
  });

  it("de-duplicates repeated pushes", () => {
    const doubled = {
      ...CAPTURE,
      pushes: [...CAPTURE.pushes, ...CAPTURE.pushes],
    };
    const twice = decodeTrends(doubled)!.trends.find((t) => t.vreg === 0xed8d)!;
    expect(twice.samples).toHaveLength(404);
  });
});

describe("30 s downsampling", () => {
  // Trend 4 (battery V, sn16), one 25-sample 30 s reply, newest first:
  // bucket A = 10 × 13.00 V, bucket B = 5 × 14.00 V + 5 not-available,
  // 5 older samples fall into an incomplete bucket that must be dropped.
  const word = (v: number): string =>
    (v & 0xff).toString(16).padStart(2, "0") +
    ((v >> 8) & 0xff).toString(16).padStart(2, "0");
  const values = [
    ...Array<number>(10).fill(1300),
    ...Array<number>(5).fill(1400),
    ...Array<number>(5).fill(0x7fff),
    ...Array<number>(5).fill(1200),
  ];
  const ref = 30159300;
  const reply =
    "04" +
    word(ref & 0xffff) +
    word(ref >>> 16) +
    "19" +
    word(30) +
    values.map(word).join("");
  const raw = {
    anchor: { timeRef: 30159400, unixMs: 1_800_000_000_000 },
    supportedHex: CAPTURE.supportedHex,
    pushes: [{ trend: 4, replies: [reply] }],
  };

  it("averages valid samples into 5-minute buckets and drops partial old ones", () => {
    const battery = decodeTrends(raw)!.trends[0];
    expect(battery.vreg).toBe(0xed8d);
    expect(battery.segments.map((s) => [s.stepS, s.count])).toEqual([[300, 2]]);
    expect(battery.samples.map((s) => s.v)).toEqual([14, 13]);
    expect(battery.samples[1].t - battery.samples[0].t).toBe(300_000);
    expect(battery.samples[1].t).toBe(
      raw.anchor.unixMs - (raw.anchor.timeRef - 30159300) * 1000,
    );
  });
});

describe("parseTrendsOutput", () => {
  it("decodes the helper's last stdout line", () => {
    const line = JSON.stringify({ victronTrendsRaw: CAPTURE, errors: [] });
    const result = parseTrendsOutput(`noise\n${line}\n`);
    expect(result.errors).toEqual([]);
    expect(result.trends?.trends).toHaveLength(4);
  });

  it("passes helper errors through with trends null", () => {
    const line = JSON.stringify({
      victronTrendsRaw: null,
      errors: ["victron-pairing-timeout"],
    });
    expect(parseTrendsOutput(line)).toEqual({
      trends: null,
      errors: ["victron-pairing-timeout"],
    });
  });

  it("throws on output that is not the contract", () => {
    expect(() => parseTrendsOutput("")).toThrow("printed nothing");
    expect(() => parseTrendsOutput("[]")).toThrow();
    expect(() => parseTrendsOutput('{"errors":[]}')).toThrow("misses");
  });
});

describe("parseAllOutput (--victron-all)", () => {
  const NOW = new Date(2026, 9, 5, 12, 0, 0);
  const DAY =
    "009400000000000000a20a7009000000000053038200000012020000bf0079135c00";
  const TOTAL = "010012000000f7dc0100f7dc01006b14e80a1e0100" + "ff".repeat(13);
  const victronHistory = {
    totalHex: TOTAL,
    days: [{ vreg: 0x1050, hex: DAY }],
  };

  it("returns both parts from one line", () => {
    const line = JSON.stringify({
      victronHistory,
      victronTrendsRaw: CAPTURE,
      errors: [],
    });
    const result = parseAllOutput(line, NOW);
    expect(result.history.days).toHaveLength(1);
    expect(result.history.total?.daysAvailable).toBe(30);
    expect(result.trends?.trends).toHaveLength(4);
    expect(result.errors).toEqual([]);
  });

  it("keeps the history when the trends failed", () => {
    const line = JSON.stringify({
      victronHistory,
      victronTrendsRaw: null,
      errors: ["victron-trends-unsupported"],
    });
    const result = parseAllOutput(line, NOW);
    expect(result.history.days).toHaveLength(1);
    expect(result.trends).toBeNull();
    expect(result.errors).toEqual(["victron-trends-unsupported"]);
  });

  it("keeps the trends when the history failed", () => {
    const line = JSON.stringify({
      victronHistory: null,
      victronTrendsRaw: CAPTURE,
      errors: ["victron-total-unreadable"],
    });
    const result = parseAllOutput(line, NOW);
    expect(result.history.days).toEqual([]);
    expect(result.history.total).toBeNull();
    expect(result.trends?.trends).toHaveLength(4);
  });
});

describe("mergeTrends", () => {
  const MIN = 60_000;
  const H = 3600_000;
  const NOW = 1_800_000_000_000;
  // Synthetic one-vreg series: samples every `stepS` from `fromMs`, v = index.
  const series = (
    fromMs: number,
    count: number,
    stepS: number,
    value: (i: number) => number | null = (i) => i,
    vreg = 0xed8d,
  ): VictronTrends => ({
    anchor: { timeRef: 1000, unixMs: fromMs + count * stepS * 1000 },
    trends: [
      {
        vreg,
        segments: [
          { stepS, fromMs, toMs: fromMs + (count - 1) * stepS * 1000, count },
        ],
        samples: Array.from({ length: count }, (_, i) => ({
          t: fromMs + i * stepS * 1000,
          v: value(i),
        })),
      },
    ],
  });
  const times = (t: VictronTrends | null, vreg = 0xed8d) =>
    t?.trends.find((x) => x.vreg === vreg)?.samples.map((s) => s.t);

  it("replaces the overlap with fresh samples despite anchor jitter", () => {
    const cached = series(NOW - 3 * H, 36, 300, () => 1); // 3 h … 5 min ago
    const fresh = series(NOW - 20 * MIN + 80, 5, 300, () => 2); // +80 ms jitter
    const merged = mergeTrends(cached, fresh, NOW)!;
    const samples = merged.trends[0].samples;
    expect(samples).toHaveLength(36 - 4 + 5); // 4 cached slots superseded
    expect(samples.slice(-5).every((s) => s.v === 2)).toBe(true);
    expect(samples.slice(0, 32).every((s) => s.v === 1)).toBe(true);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].t - samples[i - 1].t).toBeGreaterThanOrEqual(
        5 * MIN - 200,
      );
    }
    expect(merged.anchor).toEqual(fresh.anchor);
  });

  it("keeps a gap between cached and fresh as a gap", () => {
    const cached = series(NOW - 10 * H, 12, 300); // ends ~9 h ago
    const fresh = series(NOW - 1 * H, 12, 300);
    const merged = mergeTrends(cached, fresh, NOW)!;
    const t = times(merged)!;
    expect(t).toHaveLength(24);
    expect(t[12] - t[11]).toBeGreaterThan(8 * H);
    expect(merged.trends[0].segments).toHaveLength(1);
  });

  it("sorts out-of-order input and de-duplicates exact repeats", () => {
    const base = series(NOW - 2 * H, 6, 300);
    const shuffled: VictronTrends = {
      ...base,
      trends: [
        { ...base.trends[0], samples: [...base.trends[0].samples].reverse() },
      ],
    };
    const merged = mergeTrends(base, shuffled, NOW)!;
    const t = times(merged)!;
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(new Set(t).size).toBe(6);
  });

  it("returns the cache (trimmed to 72 h) for an empty fresh result", () => {
    const cached = series(NOW - 80 * H, 12 * 80, 300); // 80 h of 5-min samples
    for (const fresh of [null, { ...cached, trends: [] }]) {
      const merged = mergeTrends(cached, fresh, NOW)!;
      const t = times(merged)!;
      expect(t[0]).toBeGreaterThanOrEqual(NOW - TREND_WINDOW_MS);
      expect(t.at(-1)).toBe(cached.trends[0].samples.at(-1)!.t);
      expect(merged.anchor).toEqual(cached.anchor);
    }
    expect(mergeTrends(null, null, NOW)).toBeNull();
  });

  it("works from an empty cache and adds vregs that only the fresh run has", () => {
    const fresh = series(NOW - H, 12, 300, (i) => i, 0xed8f);
    expect(mergeTrends(null, fresh, NOW)?.trends.map((t) => t.vreg)).toEqual([
      0xed8f,
    ]);
    const cached = series(NOW - 2 * H, 12, 300);
    expect(mergeTrends(cached, fresh, NOW)?.trends.map((t) => t.vreg)).toEqual([
      0xed8d, 0xed8f,
    ]);
  });

  it("prefers the finer step where steps overlap, and rebuilds the segments", () => {
    const coarse = series(NOW - 6 * H, 12, 1800, () => 1); // 6 h … 30 min ago
    const fine = series(NOW - 2 * H, 24, 300, () => 2); // 2 h … 5 min ago
    const merged = mergeTrends(coarse, fine, NOW)!;
    const trend = merged.trends[0];
    expect(trend.segments.map((s) => s.stepS)).toEqual([1800, 300]);
    expect(trend.segments[1].fromMs).toBeGreaterThanOrEqual(
      NOW - 2 * H - 150_000,
    );
    expect(trend.samples.filter((s) => s.v === 2)).toHaveLength(24);
    expect(trend.segments.reduce((n, s) => n + s.count, 0)).toBe(
      trend.samples.length,
    );
  });

  it("trims to the 72 h before now", () => {
    const old = series(NOW - 100 * H, 4, 1800);
    const merged = mergeTrends(old, series(NOW - H, 4, 300), NOW)!;
    expect(times(merged)!.every((t) => t >= NOW - TREND_WINDOW_MS)).toBe(true);
  });

  it("merges a real incremental run into the real full capture", () => {
    const cached = decodeTrends(CAPTURE)!;
    const fresh = decodeTrends(TRENDS_INCREMENTAL)!;
    expect(fresh.trends.map((t) => t.vreg)).toEqual([0xed8d]);
    expect(fresh.trends[0].segments.map((s) => s.stepS)).toEqual([300]);
    const merged = mergeTrends(cached, fresh, fresh.anchor.unixMs)!;
    const battery = merged.trends.find((t) => t.vreg === 0xed8d)!;
    const cachedBattery = cached.trends.find((t) => t.vreg === 0xed8d)!;
    // Other vregs come through from the cache untouched.
    expect(merged.trends.map((t) => t.vreg)).toEqual(
      cached.trends.map((t) => t.vreg),
    );
    expect(merged.anchor).toEqual(fresh.anchor);
    expect(battery.samples.at(-1)!.t).toBe(fresh.trends[0].samples.at(-1)!.t);
    expect(battery.samples.length).toBeGreaterThan(
      cachedBattery.samples.length,
    );
    for (let i = 1; i < battery.samples.length; i++) {
      const dt = battery.samples[i].t - battery.samples[i - 1].t;
      expect(dt).toBeGreaterThanOrEqual(5 * MIN - 1000);
    }
    // The cache's older part is intact.
    expect(battery.samples[0].t).toBe(cachedBattery.samples[0].t);
  });
});
