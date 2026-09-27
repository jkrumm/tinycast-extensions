import { argoFetch } from "../lib/argo";
import { TimeseriesResponse, UsageSummaryResponse } from "./types";

export { aggregateSpend, topLanesWithOther } from "./aggregate";

export function getTimeseries(): Promise<TimeseriesResponse> {
  return argoFetch<TimeseriesResponse>(
    "/usage/timeseries?range=7d&grain=day&metric=cost&groupBy=sub_tool",
  );
}

export function getSummary(): Promise<UsageSummaryResponse> {
  return argoFetch<UsageSummaryResponse>("/usage/summary");
}
