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
  const sevenDayTotal = buckets.reduce((sum, bucket) => {
    const bucketTotal = Object.values(bucket.groups).reduce(
      (a: number, b) => a + (b ?? 0),
      0,
    );
    return sum + bucketTotal;
  }, 0);

  return { today, todayTotal, sevenDayTotal };
}
