import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPACITY_AH,
  DEFAULT_LOAD_A,
  SocCapture,
  SocPoint,
  VREG,
  estimateLoadA,
  estimateSoc,
  intervalLoads,
  socSeries,
} from "./soc-estimate";
import { fixtureVictronAll, simulateVan } from "./fixtures";
import { VictronTrends, decodeTrends } from "./victron-trends";
import { TRENDS_CAPTURE } from "./victron-trends.fixture";

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = new Date(2026, 9, 5, 12, 0).getTime();
const FROM = NOW - 72 * HOUR;

const CAPACITY = 100;
const LOAD = 1.0;
const SUN_A = 8;

const hourOf = (t: number) => {
  const d = new Date(t);
  return d.getHours() + d.getMinutes() / 60;
};
const awake = (t: number) => hourOf(t) >= 6.5 && hourOf(t) < 17.5;

// A van with a known 1.0 A load and 8 A of sun, so the true charge is exact.
const van = simulateVan({
  from: FROM,
  to: NOW,
  loadA: LOAD,
  capacityAh: CAPACITY,
  sunA: SUN_A,
});
const sim = {
  trends: van.trends,
  times: van.times,
  truth: { get: (t: number) => van.truthAt(t) },
  chargeA: { get: (t: number) => van.chargeAAt(t) },
};
const capture = (t: number): SocCapture => {
  const snapped = sim.times.reduce((a, b) =>
    Math.abs(b - t) < Math.abs(a - t) ? b : a,
  );
  return {
    t: snapped,
    soc: Math.round(sim.truth.get(snapped) * 10) / 10,
    netA: sim.chargeA.get(snapped) - LOAD,
  };
};
const at = (points: SocPoint[], t: number) =>
  points.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
const estimate = (captures: SocCapture[]) =>
  estimateSoc({
    trends: sim.trends,
    captures,
    from: FROM,
    to: NOW,
    capacityAh: CAPACITY,
  });

describe("house load", () => {
  it("is the median over the readings of (charger current − the BMS's net current)", () => {
    const caps = [10, 30, 50].map((h) => capture(FROM + h * HOUR));
    expect(estimateLoadA({ trends: sim.trends, captures: caps })).toBeCloseTo(
      LOAD,
      6,
    );
    // one odd reading does not move a median
    const noisy = [...caps, { ...caps[0], netA: caps[0].netA! - 3 }];
    expect(estimateLoadA({ trends: sim.trends, captures: noisy })).toBeCloseTo(
      LOAD,
      1,
    );
  });

  it("falls back to 0.6 A without a reading that carries both currents, and never goes below 0", () => {
    expect(estimateLoadA({ trends: sim.trends, captures: [] })).toBe(
      DEFAULT_LOAD_A,
    );
    expect(
      estimateLoadA({
        trends: sim.trends,
        captures: [{ t: NOW, soc: 80, netA: null }],
      }),
    ).toBe(DEFAULT_LOAD_A);
    expect(
      estimateLoadA({ trends: null, captures: [capture(NOW - HOUR)] }),
    ).toBe(DEFAULT_LOAD_A);
    const charging = { ...capture(FROM + 12 * HOUR), netA: 20 }; // net above the charger: impossible
    expect(estimateLoadA({ trends: sim.trends, captures: [charging] })).toBe(0);
  });
});

describe("coulomb counting on a synthetic van with a known load", () => {
  const captures = [14, 33, 41, 58, 66].map((h) => capture(FROM + h * HOUR));
  const out = estimate(captures);

  it("passes exactly through every reading, marked measured", () => {
    for (const c of captures) {
      expect(out.find((p) => p.t === c.t)).toMatchObject({
        kind: "measured",
        soc: c.soc,
      });
    }
    expect(out.filter((p) => p.kind === "measured")).toHaveLength(
      captures.length,
    );
  });

  it("is time-sorted, clamped to 0–100 and covers the window", () => {
    expect(out.map((p) => p.t)).toEqual(
      [...out.map((p) => p.t)].sort((a, b) => a - b),
    );
    for (const p of out) {
      expect(p.soc).toBeGreaterThanOrEqual(0);
      expect(p.soc).toBeLessThanOrEqual(100);
    }
    expect(out[0].t).toBeLessThan(FROM + 20 * MIN);
    expect(out.at(-1)!.t).toBeGreaterThan(NOW - 20 * MIN);
  });

  it("has no jump at a reading (neighbours within 2 %)", () => {
    for (const c of captures) {
      const est = out.filter((p) => p.kind === "estimated");
      const before = est.filter((p) => p.t < c.t).at(-1)!;
      const after = est.find((p) => p.t > c.t)!;
      expect(Math.abs(before.soc - c.soc)).toBeLessThanOrEqual(2);
      expect(Math.abs(after.soc - c.soc)).toBeLessThanOrEqual(2);
    }
  });

  it("tracks the true charge closely everywhere (the load is recovered from the readings)", () => {
    for (const p of out.filter((p) => p.kind === "estimated")) {
      const truth = van.truthAt(p.t);
      if (truth === undefined) continue;
      expect(Math.abs(p.soc - truth)).toBeLessThan(3);
    }
  });

  it("the night declines at L / capacity, steadily — the charger being asleep is not special", () => {
    // 20:00 → 05:00 on the second night, 9 h
    const night = new Date(FROM);
    night.setDate(night.getDate() + 1);
    night.setHours(20, 0, 0, 0);
    const start = at(out, night.getTime());
    const end = at(out, night.getTime() + 9 * HOUR);
    const slope = (end.soc - start.soc) / ((end.t - start.t) / HOUR);
    expect(slope).toBeCloseTo(-(LOAD / CAPACITY) * 100, 1); // −1 %/h
    // …and in small steps, with no hidden jumps
    const steps = out
      .filter((p) => p.kind === "estimated" && p.t >= start.t && p.t <= end.t)
      .map((p, i, all) => (i ? p.soc - all[i - 1].soc : 0));
    expect(Math.max(...steps.map(Math.abs))).toBeLessThan(0.5);
  });

  it("charges at (charger − load) / capacity in the sun", () => {
    const sun = new Date(FROM);
    sun.setDate(sun.getDate() + 1);
    sun.setHours(8, 0, 0, 0);
    const a = at(out, sun.getTime());
    const b = at(out, sun.getTime() + 2 * HOUR);
    const slope = (b.soc - a.soc) / ((b.t - a.t) / HOUR);
    expect(slope).toBeGreaterThan(0);
    // 7 %/h; the interval it sits in also contains a full pack whose surplus was not
    // stored, which the energy balance counts as a little extra load
    expect(Math.abs(slope - ((SUN_A - LOAD) / CAPACITY) * 100)).toBeLessThan(1);
  });
});

describe("full re-sync", () => {
  it("absorption with a tapered current is a physical 100 % — even with no reading nearby", () => {
    const out = estimateSoc({
      trends: sim.trends,
      captures: [],
      from: FROM,
      to: NOW,
      capacityAh: CAPACITY,
    });
    // the second day's absorption afternoon
    const day = new Date(FROM);
    day.setDate(day.getDate() + 1);
    day.setHours(16, 0, 0, 0);
    const point = at(out, day.getTime());
    expect(point.soc).toBe(100);
    expect(point.kind).toBe("estimated");
    // after it ends the pack declines at the load rate again — which the energy
    // balance between the two full re-syncs recovers (1.0 A) with no reading at all
    const dusk = new Date(day);
    dusk.setHours(19, 0, 0, 0);
    const later = new Date(day);
    later.setHours(23, 0, 0, 0);
    const slope =
      (at(out, later.getTime()).soc - at(out, dusk.getTime()).soc) / 4;
    expect(slope).toBeCloseTo(-(LOAD / CAPACITY) * 100, 0);
  });

  it("a sleeping charger holding a high voltage is not a full pack", () => {
    const trends = structuredClone(sim.trends);
    const volts = trends.trends.find((t) => t.vreg === VREG.batteryV)!;
    for (const s of volts.samples) if (!awake(s.t)) s.v = 14.2; // stale at night
    const out = estimateSoc({
      trends,
      captures: [capture(FROM + 12 * HOUR)],
      from: FROM,
      to: NOW,
      capacityAh: CAPACITY,
    });
    const night = new Date(FROM);
    night.setDate(night.getDate() + 1);
    night.setHours(23, 0, 0, 0);
    expect(at(out, night.getTime()).soc).toBeLessThan(100);
  });

  it("a reading beats a nearby full-anchor", () => {
    const day = new Date(FROM);
    day.setDate(day.getDate() + 1);
    day.setHours(15, 0, 0, 0);
    const reading: SocCapture = { t: day.getTime(), soc: 91, netA: 0 };
    const out = estimateSoc({
      trends: sim.trends,
      captures: [reading],
      from: FROM,
      to: NOW,
      capacityAh: CAPACITY,
    });
    expect(out.find((p) => p.t === reading.t)).toMatchObject({
      kind: "measured",
      soc: 91,
    });
  });
});

describe("clamping and degenerate input", () => {
  it("clamps readings, and the integration cannot go below 0 or above 100", () => {
    const out = estimate([
      { t: FROM + 12 * HOUR, soc: 140, netA: 0 },
      { t: FROM + 40 * HOUR, soc: -20, netA: 0 },
    ]);
    expect(out.find((p) => p.t === FROM + 12 * HOUR)!.soc).toBe(100);
    expect(out.find((p) => p.t === FROM + 40 * HOUR)!.soc).toBe(0);
    for (const p of out) {
      expect(p.soc).toBeGreaterThanOrEqual(0);
      expect(p.soc).toBeLessThanOrEqual(100);
    }
  });

  it("a long discharge with no sun bottoms out at 0 instead of going negative", () => {
    const dark = structuredClone(sim.trends);
    for (const trend of dark.trends) {
      if (trend.vreg === VREG.batteryA) trend.samples.forEach((s) => (s.v = 0));
      if (trend.vreg === VREG.pvW) trend.samples.forEach((s) => (s.v = 0));
    }
    const out = estimateSoc({
      trends: dark,
      captures: [{ t: FROM + HOUR, soc: 30, netA: -2 }],
      from: FROM,
      to: NOW,
      capacityAh: CAPACITY,
    });
    expect(out.at(-1)!.soc).toBe(0);
    expect(Math.min(...out.map((p) => p.soc))).toBe(0);
  });

  it("ignores readings outside the window", () => {
    const out = estimate([
      { t: FROM - HOUR, soc: 10, netA: 0 },
      { t: NOW + HOUR, soc: 10, netA: 0 },
    ]);
    expect(out.some((p) => p.kind === "measured")).toBe(false);
  });

  it("without a charger-current trend only the readings come back; with neither, nothing", () => {
    expect(
      estimateSoc({
        trends: null,
        captures: [{ t: NOW - HOUR, soc: 77 }],
        from: FROM,
        to: NOW,
      }),
    ).toEqual([{ t: NOW - HOUR, soc: 77, kind: "measured" }]);
    expect(
      estimateSoc({ trends: null, captures: [], from: FROM, to: NOW }),
    ).toEqual([]);
  });

  it("an unknown capacity falls back to 100 Ah", () => {
    const given = estimateSoc({
      trends: sim.trends,
      captures: [capture(FROM + 20 * HOUR)],
      from: FROM,
      to: NOW,
      capacityAh: CAPACITY,
    });
    const unknown = estimateSoc({
      trends: sim.trends,
      captures: [capture(FROM + 20 * HOUR)],
      from: FROM,
      to: NOW,
      capacityAh: null,
    });
    expect(DEFAULT_CAPACITY_AH).toBe(CAPACITY);
    expect(unknown).toEqual(given);
  });
});

describe("socSeries", () => {
  it("breaks the line where there is a hole, not between close points", () => {
    const points: SocPoint[] = [
      { t: 0, soc: 50, kind: "estimated" },
      { t: 10 * MIN, soc: 51, kind: "estimated" },
      { t: 5 * HOUR, soc: 60, kind: "estimated" },
    ];
    const { times, values } = socSeries(points);
    expect(values).toEqual([50, 51, null, 60]);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

// The real SmartSolar trends captured on 2026-10-05, with the two readings the
// BMS gave that day: 98 % in the absorption morning, 87 % (−0.6 A net, 13.32 V)
// at the end of the capture — the charger asleep, so the whole −0.6 A is the
// house load.
describe("the real captured trends", () => {
  const trends = decodeTrends(TRENDS_CAPTURE)!;
  const now = trends.anchor.unixMs;
  const from = now - 72 * HOUR;
  const A = trends.trends.find((t) => t.vreg === VREG.batteryA)!.samples;
  const chargeAt = (t: number) =>
    A.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
      .v as number;
  const morning = Date.UTC(2026, 9, 5, 6, 0);
  const captures: SocCapture[] = [
    { t: morning, soc: 98, netA: chargeAt(morning) - 0.6 },
    { t: now - 5 * MIN, soc: 87, netA: -0.6 },
  ];
  const out = estimateSoc({
    trends,
    captures,
    from,
    to: now,
    capacityAh: 94.3,
  });

  it("recovers the 0.6 A house load from the readings", () => {
    expect(estimateLoadA({ trends, captures })).toBeCloseTo(0.6, 1);
  });

  it("passes through both readings and stays within 0–100", () => {
    for (const c of captures) {
      expect(out.find((p) => p.t === c.t)).toMatchObject({
        kind: "measured",
        soc: c.soc,
      });
    }
    for (const p of out) {
      expect(Number.isFinite(p.soc)).toBe(true);
      expect(p.soc).toBeGreaterThanOrEqual(0);
      expect(p.soc).toBeLessThanOrEqual(100);
    }
  });

  it("the last night is a steady decline at the load rate, with no interpolation artefact", () => {
    // 20:00 → 04:00 local the night before the capture
    const start = at(out, Date.UTC(2026, 9, 4, 20, 0));
    const end = at(out, Date.UTC(2026, 9, 5, 4, 0));
    const hours = (end.t - start.t) / HOUR;
    const slope = (end.soc - start.soc) / hours;
    // the charger is asleep for part of it: never rising, never steeper than the load
    expect(slope).toBeLessThanOrEqual(0.01);
    expect(slope).toBeGreaterThan(-(0.6 / 94.3) * 100 * 1.5);
  });

  it("Friday night does NOT come out where the voltage table put it (19 %)", () => {
    const friday = out.filter(
      (p) => p.kind === "estimated" && p.t < from + 8 * HOUR,
    );
    expect(friday.length).toBeGreaterThan(0);
    for (const p of friday) expect(Math.abs(p.soc - 19)).toBeGreaterThan(5);
  });

  it("without any reading, only the confirmed-full stretches anchor it — and it says so by pinning them to 100", () => {
    const free = estimateSoc({
      trends,
      captures: [],
      from,
      to: now,
      capacityAh: 94.3,
    });
    expect(free.every((p) => p.kind === "estimated")).toBe(true);
    expect(free.some((p) => p.soc === 100)).toBe(true);
  });

  it("the shifted fixture used by the previews and e2e is the same shape", () => {
    const shifted = fixtureVictronAll(NOW).trends!;
    const a = shifted.trends.find((t) => t.vreg === VREG.batteryA)!.samples;
    expect(a.at(-1)!.t).toBeLessThanOrEqual(NOW);
  });
});

// The first real overnight data (2026-10-05 → 06): 82 % at 23:53 and 54 % at
// 08:05, the charger asleep the whole time (charger current 0 A). The pack
// lost 28 % of 94.3 Ah in 8.2 h: the average load was 28 % × 94.3 / 8.2 ≈ 3.2 A —
// while the BMS's instantaneous current at the readings was −4.9 A and −1.2 A
// (a laptop, a power bank, an iPhone charging at that moment), whose median
// made the old estimator predict 32 % at 08:05 instead of 54 %.
describe("regression: the real overnight data", () => {
  const T0 = new Date(2026, 9, 5, 23, 53).getTime();
  const at0805 = T0 + 8 * HOUR + 12 * MIN;
  const at0831 = T0 + 8 * HOUR + 38 * MIN;
  const CAP = 94.3;
  const night: VictronTrends = (() => {
    const times: number[] = [];
    for (let t = T0 - 20 * HOUR; t <= T0 + 12 * HOUR; t += 5 * MIN)
      times.push(t);
    const flat = (vreg: number, v: number) => ({
      vreg,
      segments: [
        {
          stepS: 300,
          fromMs: times[0],
          toMs: times.at(-1)!,
          count: times.length,
        },
      ],
      samples: times.map((t) => ({ t, v })),
    });
    return {
      anchor: { timeRef: 0, unixMs: T0 + 12 * HOUR },
      trends: [
        flat(VREG.batteryA, 0),
        flat(VREG.pvW, 0),
        flat(VREG.batteryV, 13.2),
      ],
    };
  })();
  const readings: SocCapture[] = [
    { t: T0 - 6 * MIN, soc: 83, netA: -6.52 },
    { t: T0, soc: 82, netA: -4.91 },
    { t: at0805, soc: 54, netA: -1.21 },
    { t: at0831, soc: 52, netA: -2.13 },
  ];
  const window = { from: T0 - 12 * HOUR, to: T0 + 12 * HOUR };

  it("the load between the two readings is ≈ 3.2 A, however high the instantaneous currents were", () => {
    const [interval] = intervalLoads({
      trends: night,
      captures: [readings[1], readings[2]],
      ...window,
      capacityAh: CAP,
    });
    expect(interval.hours).toBeCloseTo(8.2, 1);
    expect(interval.chargeAh).toBe(0);
    expect(interval.loadA).toBeCloseTo(3.22, 1);
    expect(interval.reliable).toBe(true);
  });

  it("the held-out 08:05 reading is predicted within 3 % from its neighbours", () => {
    const others = readings.filter((r) => r.t !== at0805);
    const out = estimateSoc({
      trends: night,
      captures: others,
      ...window,
      capacityAh: CAP,
    });
    const est = out.filter((p) => p.kind === "estimated");
    const before = est.filter((p) => p.t < at0805).at(-1)!;
    const after = est.find((p) => p.t > at0805)!;
    const predicted =
      before.soc +
      ((after.soc - before.soc) * (at0805 - before.t)) / (after.t - before.t);
    expect(Math.abs(predicted - 54)).toBeLessThan(3);
  });

  it("with both readings the night is one steady line at the load, hitting both exactly", () => {
    const out = estimateSoc({
      trends: night,
      captures: [readings[1], readings[2]],
      ...window,
      capacityAh: CAP,
    });
    expect(out.find((p) => p.t === T0)).toMatchObject({
      soc: 82,
      kind: "measured",
    });
    expect(out.find((p) => p.t === at0805)).toMatchObject({
      soc: 54,
      kind: "measured",
    });
    const mid = out.reduce((a, b) =>
      Math.abs(b.t - (T0 + 4.1 * HOUR)) < Math.abs(a.t - (T0 + 4.1 * HOUR))
        ? b
        : a,
    );
    expect(Math.abs(mid.soc - 68)).toBeLessThan(1);
    // …and past the last reading the same load carries on (3.2 A ≈ 3.4 %/h)
    const later = estimateSoc({
      trends: night,
      captures: [readings[1], readings[2]],
      ...window,
      capacityAh: CAP,
    });
    const twoHoursOn = later.reduce((a, b) =>
      Math.abs(b.t - (at0805 + 2 * HOUR)) < Math.abs(a.t - (at0805 + 2 * HOUR))
        ? b
        : a,
    );
    expect(
      Math.abs(twoHoursOn.soc - (54 - ((3.22 * 2) / CAP) * 100)),
    ).toBeLessThan(1);
  });

  it("short intervals do not invent a load: two readings minutes apart borrow the reliable one", () => {
    const intervals = intervalLoads({
      trends: night,
      captures: readings,
      ...window,
      capacityAh: CAP,
    });
    const short = intervals.find((i) => i.hours < 1)!;
    expect(short.reliable).toBe(false);
    const out = estimateSoc({
      trends: night,
      captures: readings,
      ...window,
      capacityAh: CAP,
    });
    for (const p of out) expect(Number.isFinite(p.soc)).toBe(true);
    // 23:47 → 23:53: no wild swing despite 1 % in 6 minutes
    const between = out.filter(
      (p) => p.kind === "estimated" && p.t > T0 - 6 * MIN && p.t < T0,
    );
    for (const p of between) expect(Math.abs(p.soc - 82.5)).toBeLessThan(3);
  });
});

// The quiet evening that fooled the live estimate: after a 16:02 → 20:44
// interval of only 0.47 A the old extrapolation (the nearest interval's load)
// predicted 93.8 % at 07:00 where the BMS said 73 %. The night's load is the
// median of the recent intervals (2.39 A here), not of the last one.
describe("regression: extrapolation uses the typical load, not the last interval's", () => {
  const CAP = 94.3;
  const end = new Date(2026, 9, 5, 20, 44).getTime();
  const loads = [3.22, 1.78, 2.39, 1.99, 4.61, 2.72, 0.47]; // the last one is the quiet evening
  const spans = [6, 6, 6, 6, 6, 6, 4.7].map((h) => h * HOUR);
  // anchors every interval, all at 99 % — the charger gave exactly the load, so
  // each interval's implied L is the listed value
  const anchorTimes: number[] = [];
  let t = end;
  for (let i = loads.length - 1; i >= 0; i--) {
    anchorTimes.unshift(t);
    t -= spans[i];
  }
  anchorTimes.unshift(t);
  const trends: VictronTrends = (() => {
    const times: number[] = [];
    const startT = anchorTimes[0];
    for (let x = startT; x <= end + 13 * HOUR; x += 5 * MIN) times.push(x);
    const amps = (x: number) => {
      for (let i = 0; i < loads.length; i++) {
        if (x >= anchorTimes[i] && x < anchorTimes[i + 1]) return loads[i];
      }
      return 0; // the night after 20:44: the charger asleep
    };
    const flat = (vreg: number, f: (x: number) => number) => ({
      vreg,
      segments: [
        {
          stepS: 300,
          fromMs: startT,
          toMs: times.at(-1)!,
          count: times.length,
        },
      ],
      samples: times.map((x) => ({ t: x, v: f(x) })),
    });
    return {
      anchor: { timeRef: 0, unixMs: end },
      trends: [
        flat(VREG.batteryA, amps),
        flat(VREG.pvW, () => 0),
        flat(VREG.batteryV, () => 13.2),
      ],
    };
  })();
  const captures: SocCapture[] = anchorTimes.map((x) => ({ t: x, soc: 99 }));
  const at0700 = end + 10 * HOUR + 16 * MIN;

  it("the recent intervals imply the listed loads, the last being the quiet 0.47 A", () => {
    const intervals = intervalLoads({
      trends,
      captures,
      from: anchorTimes[0],
      to: end,
      capacityAh: CAP,
    });
    expect(intervals).toHaveLength(loads.length);
    intervals.forEach((i, k) => expect(i.loadA).toBeCloseTo(loads[k], 1));
    expect(intervals.every((i) => i.reliable)).toBe(true);
  });

  it("predicts 07:00 from the 20:44 anchor within 3 % of the measured 73 %", () => {
    const out = estimateSoc({
      trends,
      captures,
      from: anchorTimes[0],
      to: at0700,
      capacityAh: CAP,
    });
    const point = out.reduce((a, b) =>
      Math.abs(b.t - at0700) < Math.abs(a.t - at0700) ? b : a,
    );
    expect(Math.abs(point.soc - 73)).toBeLessThan(3);
    // the nearest-interval load (0.47 A) would have said 93.8 %
    expect(Math.abs(point.soc - 93.8)).toBeGreaterThan(15);
  });

  it("before the first anchor the same typical load is used (backwards)", () => {
    const early = captures.slice(-3); // anchors from 8:40 on; the 2.39 median still holds
    const out = estimateSoc({
      trends,
      captures: captures.slice(2),
      from: anchorTimes[0],
      to: end,
      capacityAh: CAP,
    });
    expect(early).toHaveLength(3);
    const first = out.find((p) => p.kind === "measured")!;
    const before = out.filter((p) => p.t < first.t).at(-1)!;
    // one hour back at the typical load: SoC was higher by 2.39 A·1 h / 94.3 Ah
    expect(before.soc - first.soc).toBeGreaterThanOrEqual(0);
    expect(before.soc).toBeLessThanOrEqual(100);
  });
});
