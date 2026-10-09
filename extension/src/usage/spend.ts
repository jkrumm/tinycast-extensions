import { argoFetch } from "../lib/argo";
import { TimeseriesResponse } from "./types";

export { aggregateSpend, spendSince, topLanesWithOther } from "./aggregate";

export function getTimeseries(): Promise<TimeseriesResponse> {
  return argoFetch<TimeseriesResponse>(
    "/usage/timeseries?range=30d&grain=day&metric=cost&groupBy=sub_tool",
  );
}
