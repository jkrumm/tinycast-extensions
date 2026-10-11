import { describe, expect, it } from "vitest";
import {
  DayConsumption,
  averageChargedAh,
  averageConsumedAh,
  consumptionPerDay,
  dailyConsumption,
  localDayStarts,
  mergeLongTrends,
  qualityOf,
  thinCaptures,
} from "./consumption";
import { simulateVan } from "./fixtures";
import { IntervalLoad, SocCapture } from "./soc-estimate";
import { VictronTrends } from "./victron-trends";

const H = 3_600_000;
const at = (dayOffset: number, hour: number, minute = 0): number =>
  new Date(2026, 9, 9 + dayOffset, hour, minute).getTime();
const NOW = at(0, 15);

const interval = (
  from: number,
  to: number,
  loadA: number,
  reliable = true,
): IntervalLoad => ({
  from,
  to,
  hours: (to - from) / H,
  fromKind: "capture",
  toKind: "capture",
  fromSoc: 50,
  toSoc: 50,
  chargeAh: 0,
  loadA,
  covered: true,
  reliable,
});

describe("localDayStarts", () => {
  it("lists local midnights, oldest first, ending today", () => {
    const starts = localDayStarts(NOW, 3);
    expect(starts).toEqual([at(-2, 0), at(-1, 0), at(0, 0)]);
  });
});

describe("qualityOf", () => {
  it("measured from 0.8, mixed from 0.3, else estimated", () => {
    expect(qualityOf(1)).toBe("measured");
    expect(qualityOf(0.8)).toBe("measured");
    expect(qualityOf(0.79)).toBe("mixed");
    expect(qualityOf(0.3)).toBe("mixed");
    expect(qualityOf(0.29)).toBe("estimated");
    expect(qualityOf(0)).toBe("estimated");
  });
});

describe("consumptionPerDay", () => {
  it("splits an interval across midnight proportionally and fills the rest with the typical load", () => {
    const days = consumptionPerDay({
      intervals: [interval(at(-1, 22), at(0, 2), 2)],
      charge: [],
      typicalA: 0.5,
      now: at(0, 12),
      days: 2,
    });
    const [yesterday, today] = days as DayConsumption[];
    expect(yesterday.consumedAh).toBeCloseTo(2 * 2 + 22 * 0.5);
    expect(yesterday.coverage).toBeCloseTo(2 / 24);
    expect(yesterday.quality).toBe("estimated");
    expect(yesterday.partial).toBe(false);
    expect(today.consumedAh).toBeCloseTo(2 * 2 + 10 * 0.5);
    expect(today.coverage).toBeCloseTo(2 / 12);
    expect(today.partial).toBe(true);
    expect(today.chargedAh).toBeNull(); // no trend in either day
  });

  it("an unreliable interval counts as uncovered and borrows the typical load", () => {
    const [day] = consumptionPerDay({
      intervals: [interval(at(0, 6), at(0, 8), 9, false)],
      charge: [],
      typicalA: 1,
      now: at(0, 12),
      days: 1,
    }) as DayConsumption[];
    expect(day.consumedAh).toBeCloseTo(12);
    expect(day.coverage).toBe(0);
    expect(day.quality).toBe("estimated");
  });

  it("omits (null) a day with no trend and no anchor interval — not zero", () => {
    const days = consumptionPerDay({
      intervals: [interval(at(0, 6), at(0, 12), 1)],
      charge: [],
      typicalA: 1,
      now: at(0, 12),
      days: 3,
    });
    expect(days[0]).toBeNull();
    expect(days[1]).toBeNull();
    expect(days[2]).not.toBeNull();
  });

  it("a day with a trend but no anchor is all typical load, charge integrated", () => {
    const charge = Array.from({ length: 25 }, (_, i) => ({
      t: at(-1, 0) + i * H,
      v: 4,
    }));
    const [day] = consumptionPerDay({
      intervals: [],
      charge,
      typicalA: 0.8,
      now: at(0, 0, 30),
      days: 2,
    }) as DayConsumption[];
    expect(day.consumedAh).toBeCloseTo(24 * 0.8);
    expect(day.quality).toBe("estimated");
    expect(day.chargedAh).toBeCloseTo(96, 0);
  });

  it("charged is only given for a day the trend covers completely", () => {
    // 06:00–18:00 yesterday only, the rest of the day has no trend
    const charge = Array.from({ length: 13 }, (_, i) => ({
      t: at(-1, 6) + i * H,
      v: 4,
    }));
    const [day] = consumptionPerDay({
      intervals: [],
      charge,
      typicalA: 0.8,
      now: at(0, 12),
      days: 2,
    }) as DayConsumption[];
    expect(day.chargedAh).toBeNull();
    expect(day.quality).toBe("pending"); // its tail lies beyond the trend
  });

  it("a day whose tail lies beyond the trend is pending, never measured", () => {
    const charge = Array.from({ length: 13 }, (_, i) => ({
      t: at(0, i),
      v: 2,
    }));
    const [day] = consumptionPerDay({
      intervals: [interval(at(0, 0), at(0, 12), 1)],
      charge,
      typicalA: 1,
      now: at(0, 18),
      days: 1,
    }) as DayConsumption[];
    expect(day.quality).toBe("pending");
    expect(day.chargedAh).toBeNull();
  });
});

describe("dailyConsumption on a simulated van", () => {
  // 1 A house load all day; the charger gives 2 A from 06:30 to 17:30, so the
  // pack never fills. The truth is exact: 24 Ah consumed, 22 Ah charged a day.
  const van = simulateVan({
    from: at(-4, 0),
    to: NOW,
    loadA: 1,
    sunA: 2,
    startSoc: 80,
  });
  const reading = (t: number): SocCapture => ({ t, soc: van.truthAt(t) });
  const readings = [-3, -2, -1, 0].flatMap((d) => [
    reading(at(d, 7)),
    ...(d === 0 ? [reading(at(0, 14, 30))] : [reading(at(d, 22))]),
  ]);

  it("recovers 24 Ah consumed and ~22 Ah charged on days with anchors hours apart", () => {
    const days = dailyConsumption({
      trends: van.trends,
      captures: readings,
      now: NOW,
      capacityAh: 100,
      days: 5,
    });
    expect(days).toHaveLength(5);
    const [none, first, ...complete] = days.slice(0, -1) as DayConsumption[];
    expect(none.quality).toBe("estimated"); // a trend, but no reading yet
    expect(first.quality).toBe("mixed"); // the hours before the first reading
    for (const d of complete) {
      expect(d.quality).toBe("measured");
      expect(d.consumedAh).toBeCloseTo(24, 0);
      expect(d.chargedAh).toBeCloseTo(22, 0);
      expect(d.partial).toBe(false);
    }
    const today = days.at(-1)!;
    expect(today.partial).toBe(true);
    expect(today.consumedAh).toBeCloseTo(15, 0); // 15 h at 1 A
    expect(today.quality).toBe("measured");
  });

  it("thins a 15-minute sampler's readings to anchors hours apart, so the days stay measured", () => {
    const dense: SocCapture[] = [];
    for (let t = at(-3, 0); t <= NOW; t += 15 * 60_000) {
      dense.push({ t, soc: Math.round(van.truthAt(t)) }); // integer %, like the BMS
    }
    const days = dailyConsumption({
      trends: van.trends,
      captures: dense,
      now: NOW,
      capacityAh: 100,
      days: 4,
    }) as DayConsumption[];
    for (const d of days.slice(0, 3)) {
      expect(d.quality).toBe("measured");
      expect(Math.abs(d.consumedAh - 24)).toBeLessThan(3);
    }
  });

  it("without a charger-current trend nothing is derived — every day is omitted", () => {
    const days = dailyConsumption({
      trends: null,
      captures: readings,
      now: NOW,
      days: 3,
    });
    expect(days).toEqual([null, null, null]);
  });

  it("with no readings at all every day rests on the 0.6 A fallback and says so", () => {
    const days = dailyConsumption({
      trends: van.trends,
      captures: [],
      now: NOW,
      days: 3,
    }) as DayConsumption[];
    expect(days.every((d) => d.quality === "estimated")).toBe(true);
    expect(days[0].consumedAh).toBeCloseTo(24 * 0.6);
  });
});

describe("regression: the Victron trend stops mid-day while the Ective readings go on", () => {
  // 2026-10-10: the last Victron read was 08:46, the background sampler kept
  // logging the Ective all day, the pack went 65 → 100 % on solar (here a
  // smaller sun, so the pack never reaches a full run of its own). Everything
  // after 08:46 used to count as 0 A charged, so the load clamped to 0 and the
  // day was "measured" with 0 Ah charged.
  const dayStart = at(0, 0);
  const trendEnd = at(0, 8, 46);
  const van = simulateVan({
    from: at(-3, 0),
    to: at(0, 23, 59),
    loadA: 1,
    sunA: 4,
    startSoc: 20,
  });
  const cut: VictronTrends = {
    ...van.trends,
    trends: van.trends.trends.map((tr) => ({
      ...tr,
      samples: tr.samples.filter((s) => s.t <= trendEnd),
    })),
  };
  const risingDay: SocCapture[] = [];
  for (let t = at(-2, 0); t <= at(0, 20); t += 15 * 60_000) {
    risingDay.push({ t, soc: Math.round(van.truthAt(t)) });
  }
  const now = at(0, 20);

  it("the intervals after the trend ends are not covered and not reliable", () => {
    const days = dailyConsumption({
      trends: cut,
      captures: risingDay,
      now,
      capacityAh: 100,
      days: 3,
    }) as DayConsumption[];
    const today = days.at(-1)!;
    expect(today.quality).toBe("pending");
    expect(today.chargedAh).toBeNull();
    expect(today.coverage).toBeLessThan(0.5);
    // the yesterday before it is covered completely and still measured
    expect(days.at(-2)!.quality).toBe("measured");
    expect(days.at(-2)!.chargedAh).not.toBeNull();
  });

  it("a top-up that reaches the evening makes the same day measured, with the real charge", () => {
    const days = dailyConsumption({
      trends: van.trends,
      captures: risingDay,
      now,
      capacityAh: 100,
      days: 1,
    }) as DayConsumption[];
    expect(days[0].quality).toBe("measured");
    expect(days[0].chargedAh).toBeGreaterThan(30);
    expect(days[0].dayStart).toBe(dayStart);
  });
});

describe("thinCaptures", () => {
  it("keeps readings at least two hours apart, oldest first", () => {
    const captures = [0, 30, 125, 90, 150, 245, 300].map((m) => ({
      t: m * 60_000,
      soc: 50,
    }));
    expect(thinCaptures(captures).map((c) => c.t / 60_000)).toEqual([
      0, 125, 245,
    ]);
  });
});

describe("mergeLongTrends", () => {
  const trends = (samples: Array<[number, number]>): VictronTrends => ({
    anchor: { timeRef: 0, unixMs: samples.at(-1)![0] },
    trends: [
      {
        vreg: 0xed8f,
        segments: [],
        samples: samples.map(([t, v]) => ({ t, v })),
      },
    ],
  });

  it("keeps both windows, dedupes by the minute and lets the later source win", () => {
    const merged = mergeLongTrends(
      trends([
        [0, 1],
        [30 * 60_000, 2],
      ]),
      trends([
        [30 * 60_000 + 700, 9],
        [60 * 60_000, 3],
      ]),
    )!;
    expect(merged.trends[0].samples.map((s) => s.v)).toEqual([1, 9, 3]);
  });

  it("passes one side through and returns null for none", () => {
    const one = trends([[0, 1]]);
    expect(mergeLongTrends(null, one)).toBe(one);
    expect(mergeLongTrends(one, null)).toBe(one);
    expect(mergeLongTrends(null, null)).toBeNull();
  });
});

describe("averages", () => {
  const day = (over: Partial<DayConsumption>): DayConsumption => ({
    dayStart: 0,
    consumedAh: 30,
    chargedAh: 40,
    coverage: 1,
    quality: "measured",
    partial: false,
    ...over,
  });

  it("average complete measured and mixed days only", () => {
    const days = [
      day({ consumedAh: 99, chargedAh: null, quality: "pending" }),
      day({ consumedAh: 20, chargedAh: 10 }),
      day({ consumedAh: 40, chargedAh: 30, quality: "mixed" }),
      day({ consumedAh: 99, chargedAh: 99, quality: "estimated" }),
      day({ consumedAh: 99, chargedAh: 99, partial: true }),
      null,
    ];
    expect(averageConsumedAh(days)).toBe(30);
    expect(averageChargedAh(days)).toBe(20);
  });

  it("is null without a usable day", () => {
    expect(averageConsumedAh([null, day({ quality: "estimated" })])).toBeNull();
    expect(averageChargedAh([])).toBeNull();
  });
});
