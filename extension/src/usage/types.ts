// Shape written by ~/.claude/fetch_usage.py to /tmp/claude_sl/usage_api.json.
export interface UsageBucket {
  utilization: number | null; // 0-100
  resets_at_epoch: number | null; // unix seconds
}

export interface UsageQuotaOk {
  five_hour: UsageBucket;
  seven_day: UsageBucket;
  seven_day_sonnet: UsageBucket;
  fetched_at: number;
}

export interface UsageQuotaError {
  error: string;
  fetched_at: 0;
}

export type UsageQuota = UsageQuotaOk | UsageQuotaError;

export function isQuotaError(q: UsageQuota): q is UsageQuotaError {
  return "error" in q;
}

// argo /usage/timeseries response
export interface TimeseriesBucket {
  bucket: string; // "YYYY-MM-DD" (UTC day)
  groups: Record<string, number | null>;
}

export interface TimeseriesResponse {
  buckets: TimeseriesBucket[];
  groupKeys: string[];
}

// argo /usage/summary response
export interface UsageSummarySource {
  source: string;
  count: number;
}

export interface UsageSummaryResponse {
  total: number;
  bySource: UsageSummarySource[];
  maxTs: number;
}

// One bucket's total spend, for the 7-day sparkline.
export interface DailyTotal {
  bucket: string; // "YYYY-MM-DD" (UTC day)
  total: number;
}

// Today + 7d spend, aggregated from TimeseriesResponse.
export interface SpendAggregate {
  today: Record<string, number>;
  todayTotal: number;
  sevenDayTotal: number;
  dailyTotals: DailyTotal[];
}
