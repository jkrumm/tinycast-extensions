// Pure ring logic for the 72 h sample history — no @raycast/api import (the
// LocalStorage glue is storage.ts).

import { Sample } from "./types";
import { VictronHistory } from "./victron-history";
import { VictronTrends } from "./victron-trends";

export const HISTORY_WINDOW_MS = 72 * 3_600_000;
export const DEDUPE_MS = 2 * 60_000;
// Charts need a shape worth drawing: fewer samples than this and they are
// omitted entirely rather than showing two dots.
export const MIN_CHART_SAMPLES = 6;

// Newest sample wins over one closer than DEDUPE_MS (a manual Refresh right
// after opening must not stack points); anything older than 72 h is dropped.
export function appendSample(history: Sample[], sample: Sample): Sample[] {
  const kept = history.filter((s) => s.t >= sample.t - HISTORY_WINDOW_MS);
  const last = kept[kept.length - 1];
  if (last && sample.t - last.t < DEDUPE_MS) kept.pop();
  return [...kept, sample];
}

export function recentSamples(history: Sample[], now: number): Sample[] {
  return history.filter((s) => s.t >= now - HISTORY_WINDOW_MS && s.t <= now);
}

export function hasChartHistory(history: Sample[], now: number): boolean {
  return recentSamples(history, now).length >= MIN_CHART_SAMPLES;
}

export interface Eta {
  direction: "full" | "empty";
  hours: number;
}

// Below this the battery is effectively idle and any ETA is noise.
const MIN_ETA_AMPS = 0.2;

export function timeToFullOrEmpty(opts: {
  soc: number | null;
  capacityAh: number | null;
  batA: number | null;
}): Eta | null {
  const { soc, capacityAh, batA } = opts;
  if (soc === null || capacityAh === null || batA === null) return null;
  if (Math.abs(batA) < MIN_ETA_AMPS || capacityAh <= 0) return null;
  if (batA > 0) {
    if (soc >= 100) return null;
    return {
      direction: "full",
      hours: (((100 - soc) / 100) * capacityAh) / batA,
    };
  }
  if (soc <= 0) return null;
  return { direction: "empty", hours: ((soc / 100) * capacityAh) / -batA };
}

// The Victron's on-device data needs a connected GATT session (the charger's
// advert is blocked meanwhile), so it is cached in LocalStorage: the 72 h
// trends are topped up incrementally on every open (cheap: only samples newer
// than the cache), the 30-day daily history only when it is from a previous
// day or over an hour old.
export const VICTRON_HISTORY_TTL_MS = 3_600_000;

const PV_POWER_VREG = 0xec8a;
const BATTERY_V_VREG = 0xed8d;
const BATTERY_A_VREG = 0xed8f;
const PV_V_VREG = 0xedbb;
// What the charts and the SoC estimate read: PV power, battery V and A, and PV
// voltage (the charger-asleep signal). Everything else the helper returns is
// dropped before it reaches LocalStorage.
const CACHED_VREGS = [PV_POWER_VREG, BATTERY_V_VREG, BATTERY_A_VREG, PV_V_VREG];
// A cache is only usable for an incremental read when it holds these three (PV
// voltage is a bonus the device does not always push).
const REQUIRED_VREGS = [PV_POWER_VREG, BATTERY_V_VREG, BATTERY_A_VREG];
const BUCKET_MS = 10 * 60_000; // ≈ 1 px per 6 min at the chart width

export interface VictronHistoryCache {
  attemptedAt: number; // epoch ms of the last read attempt
  ok: boolean; // whether that attempt succeeded
  updatedAt: number | null; // when anything was last read successfully
  historyAt: number | null; // when the daily history was last read
  history: VictronHistory | null; // the last successful daily history, however old
  // The merged 72 h PV-power and battery-voltage trends (only those two
  // vregs, whole watts / 10 mV), at the device's own 5 / 30 minute resolution
  // so a fresh incremental read can be merged into it.
  trends: VictronTrends | null;
}

const round = (value: number | null, vreg: number): number | null =>
  value === null
    ? null
    : vreg === PV_POWER_VREG
      ? Math.round(value)
      : Math.round(value * 100) / 100;

// A cache written before the SoC estimate (PV power + battery V only) lacks the
// current: its older samples could never be completed by an incremental read.
export function hasRequiredTrends(trends: VictronTrends | null): boolean {
  return REQUIRED_VREGS.every((vreg) =>
    trends?.trends.some((t) => t.vreg === vreg),
  );
}

// Keeps what the chart draws and rounds it — small enough for LocalStorage.
export function compactTrends(
  trends: VictronTrends | null,
): VictronTrends | null {
  if (!trends) return null;
  const kept = trends.trends
    .filter((t) => CACHED_VREGS.includes(t.vreg))
    .map((t) => ({
      ...t,
      samples: t.samples.map((s) => ({ t: s.t, v: round(s.v, t.vreg) })),
    }));
  return kept.length > 0 ? { anchor: trends.anchor, trends: kept } : null;
}

// Where an incremental read should start: the newest sample *every* cached
// series has (the lagging one decides). undefined: nothing cached, read it all.
export function newestTrendSample(
  trends: VictronTrends | null,
): number | undefined {
  const newest = (trends?.trends ?? []).map((t) => t.samples.at(-1)?.t ?? 0);
  return newest.length > 0 ? Math.min(...newest) : undefined;
}

export type TrendPoint = [number, number | null]; // [epoch ms, value]

function trendPoints(trends: VictronTrends | null, vreg: number): TrendPoint[] {
  const trend = trends?.trends.find((t) => t.vreg === vreg);
  if (!trend) return [];
  const buckets = new Map<number, number[]>();
  for (const { t, v } of trend.samples) {
    if (v === null) continue;
    const key = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    buckets.set(key, [...(buckets.get(key) ?? []), v]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, values]): TrendPoint => {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return [t + BUCKET_MS / 2, round(mean, vreg)];
    });
}

// What the 72 h charts draw, averaged into 10-minute buckets, oldest first.
export const solarPoints = (trends: VictronTrends | null): TrendPoint[] =>
  trendPoints(trends, PV_POWER_VREG);

const sameLocalDay = (a: number, b: number): boolean =>
  new Date(a).toDateString() === new Date(b).toDateString();

// The daily history changes once a day: re-read it when there is none, when it
// is from a previous local day (its "today" would be a day off) or over an hour
// old. (The trends are not gated — every open tops them up.)
export function victronHistoryDue(
  cache: VictronHistoryCache | null,
  now: number,
): boolean {
  if (!cache?.history || cache.historyAt === null) return true;
  if (!sameLocalDay(cache.historyAt, now)) return true;
  return now - cache.historyAt >= VICTRON_HISTORY_TTL_MS;
}
