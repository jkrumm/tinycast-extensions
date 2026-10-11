// Daily consumption in Ah — how much the house loads drew per local day, and
// how much the Victron charged in, with an honest quality marker. Pure (no
// `@raycast/api`), unit-tested.
//
// The consumption is the load the SoC estimator already infers between
// consecutive anchors (readings, confirmed fulls): over an interval
//
//   L = (∫ charger current dt − ΔSoC · capacity / 100) / Δt
//
// so a day's Ah is ∫ L dt, an interval split across midnight proportionally.
// Hours outside every reliable interval (before the first / after the last
// anchor, or inside a too-short / full-pinned interval) use the estimator's
// typical load (`typicalLoadA`) — that part is a guess, and `coverage` says how
// much of the day it is: measured ≥ 80 % of the elapsed hours inside reliable
// intervals, mixed ≥ 30 %, otherwise estimated.
//
// **The charger-current trend decides what can be known at all.** It only grows
// when the Victron's connected GATT session is read (Van Power on open, or the
// sampler's top-up every ~3 h), while the Ective readings keep coming. Past the
// trend's last sample "no sample" is not "0 A charged": an interval the trend
// does not cover is not reliable (`IntervalLoad.covered`), `chargedAh` is only
// given for a day the trend covers completely, and a day whose tail (over an
// hour) lies beyond the trend is "pending" — waiting for Victron data — never
// "measured".
//
// Accuracy: about ±3–5 % on a day with anchors hours apart — the SoC is an
// integer % (≈ 0.94 Ah on this pack), which is the error of each anchor and is
// spread over its interval. Blind spot: charge from a source the Victron does not see (shore
// power, alternator, a charger on the Ective) raises the SoC without raising
// `chargedAh`, so it reads as LOWER consumption (even 0 for a day on shore
// power). Only Victron charge is counted as "charged in".

import { VictronTrends } from "./victron-trends";
import {
  DEFAULT_CAPACITY_AH,
  IntervalLoad,
  MIN_INTERVAL_MS,
  Series,
  SocCapture,
  VREG,
  chargeBetween,
  coveredSpans,
  intervalLoads,
  seriesOf,
  spansCover,
  typicalLoadA,
} from "./soc-estimate";

export const CONSUMPTION_DAYS = 14;
export const MEASURED_COVERAGE = 0.8;
export const MIXED_COVERAGE = 0.3;
// A day whose tail lies this far beyond the charger trend waits for Victron data.
export const PENDING_TAIL_MS = 3_600_000;

export type ConsumptionQuality = "measured" | "mixed" | "estimated" | "pending"; // the Victron trend stops before the day does — not yet knowable

export interface DayConsumption {
  dayStart: number; // local midnight, epoch ms
  consumedAh: number;
  chargedAh: number | null; // null: the Victron trend does not cover all of the day's elapsed hours
  coverage: number; // 0–1, share of the day's elapsed hours inside reliable intervals
  quality: ConsumptionQuality;
  partial: boolean; // today: only the hours so far
}

const HOUR = 3_600_000;

export function qualityOf(coverage: number): ConsumptionQuality {
  if (coverage >= MEASURED_COVERAGE) return "measured";
  return coverage >= MIXED_COVERAGE ? "mixed" : "estimated";
}

// Local midnights, oldest first, ending with the one at or before `now`.
// Built from the calendar fields, so a DST day is 23 or 25 hours, not 24.
export function localDayStarts(now: number, days: number): number[] {
  const today = new Date(now);
  return Array.from({ length: days }, (_, i) =>
    new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - (days - 1 - i),
    ).getTime(),
  );
}

const nextMidnight = (dayStart: number): number => {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

// One entry per local day (oldest first, the last is today). null: nothing at
// all to say about the day — no anchor interval touches it and the Victron
// trend has no sample in it — which is not the same as zero consumption.
export function consumptionPerDay(opts: {
  intervals: IntervalLoad[];
  charge: Series;
  typicalA: number;
  now: number;
  days?: number;
}): Array<DayConsumption | null> {
  const { intervals, charge, typicalA, now } = opts;
  const reliable = intervals.filter((i) => i.reliable);
  const spans = coveredSpans(charge);
  const trendEnd = spans.at(-1)?.to;
  return localDayStarts(now, opts.days ?? CONSUMPTION_DAYS).map((dayStart) => {
    const end = Math.min(nextMidnight(dayStart), now);
    if (end <= dayStart) return null;
    const hasTrend = charge.some((s) => s.t >= dayStart && s.t < end);
    const hasAnchors = intervals.some((i) => i.to > dayStart && i.from < end);
    if (!hasTrend && !hasAnchors) return null;

    const elapsedH = (end - dayStart) / HOUR;
    let coveredH = 0;
    let consumedAh = 0;
    for (const i of reliable) {
      const overlapH =
        Math.max(0, Math.min(i.to, end) - Math.max(i.from, dayStart)) / HOUR;
      coveredH += overlapH;
      consumedAh += overlapH * i.loadA;
    }
    consumedAh += Math.max(0, elapsedH - coveredH) * typicalA;
    const coverage = Math.min(1, coveredH / elapsedH);
    const tailMs =
      trendEnd === undefined
        ? 0
        : Math.max(0, end - Math.max(dayStart, trendEnd));
    return {
      dayStart,
      consumedAh,
      chargedAh: spansCover(spans, dayStart, end)
        ? chargeBetween(charge, dayStart, end)
        : null,
      coverage,
      quality: tailMs > PENDING_TAIL_MS ? "pending" : qualityOf(coverage),
      partial: end < nextMidnight(dayStart),
    };
  });
}

// Readings further apart than the estimator's minimum interval, oldest first
// (each kept reading is at least that long after the previous kept one). The
// background sampler logs a reading every ~15 minutes, and an interval that
// short is never reliable (a 1 % step over 15 min is ±4 A of load), so every
// day would come out "estimated"; the thinned readings are the anchors a day's
// Ah is derived from, over spans the integer SoC can resolve.
export function thinCaptures(captures: SocCapture[]): SocCapture[] {
  const kept: SocCapture[] = [];
  for (const c of [...captures].sort((a, b) => a.t - b.t)) {
    const last = kept.at(-1);
    if (!last || c.t - last.t >= MIN_INTERVAL_MS) kept.push(c);
  }
  return kept;
}

// The whole computation from raw inputs: the readings (the Ective SoC, exact)
// and the Victron trends (charger current, voltage, PV power) over the window.
export function dailyConsumption(opts: {
  trends: VictronTrends | null;
  captures: SocCapture[];
  now: number;
  capacityAh?: number | null;
  days?: number;
}): Array<DayConsumption | null> {
  const { trends, now } = opts;
  const captures = thinCaptures(opts.captures);
  const days = opts.days ?? CONSUMPTION_DAYS;
  const charge = seriesOf(trends, VREG.batteryA);
  // Without a charger-current trend the energy balance has no charge side: a
  // load derived from the SoC alone would be the net drain, not consumption.
  if (charge.length === 0) return localDayStarts(now, days).map(() => null);
  const from = localDayStarts(now, days)[0];
  const intervals = intervalLoads({
    trends,
    captures,
    from,
    to: now,
    capacityAh: opts.capacityAh ?? DEFAULT_CAPACITY_AH,
  });
  return consumptionPerDay({
    intervals,
    charge,
    typicalA: typicalLoadA({ intervals, to: now, trends, captures }),
    now,
    days,
  });
}

// Two trends from different stores (the 30-day log and the 72 h cache) as one,
// per vreg deduplicated by the minute with `later` winning — the same rule
// `parseTrendsLog` applies between reads. No window trim: that is the point.
export function mergeLongTrends(
  earlier: VictronTrends | null,
  later: VictronTrends | null,
): VictronTrends | null {
  if (!earlier || !later) return earlier ?? later;
  const vregs = new Set(
    [...earlier.trends, ...later.trends].map((t) => t.vreg),
  );
  const trends = [...vregs].map((vreg) => {
    const byMinute = new Map<number, { t: number; v: number | null }>();
    for (const source of [earlier, later]) {
      for (const s of source.trends.find((t) => t.vreg === vreg)?.samples ??
        []) {
        byMinute.set(Math.round(s.t / 60_000), s);
      }
    }
    return {
      vreg,
      segments: [],
      samples: [...byMinute.values()].sort((a, b) => a.t - b.t),
    };
  });
  return { anchor: later.anchor, trends };
}

const countsInAverage = (d: DayConsumption): boolean =>
  d.quality === "measured" || d.quality === "mixed";

// The average of the complete days that were not merely estimated — what the
// chart's dashed line and the heading say. null when there is no such day.
export function averageConsumedAh(
  days: Array<DayConsumption | null>,
): number | null {
  const usable = days.flatMap((d) =>
    d && !d.partial && countsInAverage(d) ? [d.consumedAh] : [],
  );
  return usable.length > 0
    ? usable.reduce((a, b) => a + b, 0) / usable.length
    : null;
}

// Same selection for what the Victron charged in (days its trend covers).
export function averageChargedAh(
  days: Array<DayConsumption | null>,
): number | null {
  const usable = days.flatMap((d) =>
    d && !d.partial && countsInAverage(d) && d.chargedAh !== null
      ? [d.chargedAh]
      : [],
  );
  return usable.length > 0
    ? usable.reduce((a, b) => a + b, 0) / usable.length
    : null;
}

// Any day still waiting for the Victron's charge data (the chart says so).
export const hasPendingDays = (days: Array<DayConsumption | null>): boolean =>
  days.some((d) => d?.quality === "pending");
