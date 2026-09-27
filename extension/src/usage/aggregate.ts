// Pure aggregation logic, split out from spend.ts so it can be unit-tested
// without pulling in @raycast/api transitively (that package ships types
// only — no runtime module — so anything importing it can't resolve under
// vitest).
import { SpendAggregate, TimeseriesResponse } from "./types";

// "Today" = the last bucket of the 7d/day-grain series. argo buckets by UTC
// day (grain=day), so this is the UTC calendar day, not the caller's local one.
export function aggregateSpend(ts: TimeseriesResponse): SpendAggregate {
  const buckets = ts.buckets;
  const todayBucket = buckets[buckets.length - 1];

  // argo returns every lane ever seen (~60), almost all 0 on a given day —
  // keep only lanes that spent something, most expensive first.
  const today = Object.fromEntries(
    Object.entries(todayBucket?.groups ?? {})
      .map(([key, value]) => [key, value ?? 0] as const)
      .filter(([, value]) => value > 0)
      .sort(([, a], [, b]) => b - a),
  );

  const todayTotal = Object.values(today).reduce((sum, v) => sum + v, 0);

  const dailyTotals = buckets.map((bucket) => ({
    bucket: bucket.bucket,
    total: Object.values(bucket.groups).reduce(
      (a: number, b) => a + (b ?? 0),
      0,
    ),
  }));
  const sevenDayTotal = dailyTotals.reduce((sum, d) => sum + d.total, 0);

  return { today, todayTotal, sevenDayTotal, dailyTotals };
}

export interface LaneSpend {
  label: string;
  value: number;
}

// Top N lanes by spend, remainder collapsed into a single "other" — the
// hero bar chart shows at most 7 rows regardless of how many lanes argo
// tracks (~60, almost all zero on a given day).
export function topLanesWithOther(
  today: Record<string, number>,
  limit = 6,
): LaneSpend[] {
  const sorted = Object.entries(today).sort(([, a], [, b]) => b - a);
  const top: LaneSpend[] = sorted
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
  const restTotal = sorted
    .slice(limit)
    .reduce((sum, [, value]) => sum + value, 0);
  if (restTotal > 0) top.push({ label: "other", value: restTotal });
  return top;
}
