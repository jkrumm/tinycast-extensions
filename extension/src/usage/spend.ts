import { argoFetch } from "../lib/argo";
import { TimeseriesResponse } from "./types";

export { aggregateSpend, spendSince, topLanesWithOther } from "./aggregate";

// The 30-day series is ~360 KB (every lane argo has ever seen, per day) —
// 7–15 s over the mobile router. "7d" (8 buckets, ~65 KB) is all the menu
// bar's today + 7-day total needs.
export function getTimeseries(
  range: "7d" | "30d" = "30d",
): Promise<TimeseriesResponse> {
  return argoFetch<TimeseriesResponse>(
    `/usage/timeseries?range=${range}&grain=day&metric=cost&groupBy=sub_tool`,
  );
}
