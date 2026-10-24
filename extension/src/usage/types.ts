// Shape written by ~/.claude/fetch_usage.py to /tmp/claude_sl/usage_api.json.
export interface UsageBucket {
  utilization: number | null; // 0-100
  resets_at_epoch: number | null; // unix seconds
}

// One entry of the endpoint's generic limit list, normalized by the fetcher.
// `kind` is "session" / "weekly_all" / "weekly_scoped" today; a scoped limit's
// `label` is its model ("Fable" on a Max plan, 2026-10) — never hardcode one.
export interface UsageLimit {
  kind: string;
  group: string | null;
  label: string | null;
  percent: number | null; // 0-100, of this limit's own allowance
  resets_at_epoch: number | null;
  severity: string | null;
  is_active: boolean | null;
  allowance_percent_of_weekly: number | null; // a scoped cap's share of the weekly limit
}

// Monthly pay-as-you-go credits past the plan limits. Money fields are minor
// units (cents) — `decimal_places` says how many.
export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  currency: string | null;
  decimal_places: number | null;
}

// One Claude Max account as the views show it — mapped from Argo's
// `quota.accounts` entry (usage/accounts.ts) or built from the local file.
export interface AccountQuota {
  id: string; // "iu" | "me" | "iu (local)"
  plan: string | null;
  fiveHourPct: number | null; // 0-100
  sevenDayPct: number | null; // 0-100
  fiveHourResetsAt: number | null; // unix seconds
  sevenDayResetsAt: number | null; // unix seconds
  authOk: boolean;
  exhaustedUntil: number | null; // unix seconds, only while in the future
  updatedAt: number; // unix seconds, already min(account.updated_at, receivedAt)
}

export interface UsageQuotaOk {
  // Every enabled account, primary first. The top-level buckets below are the
  // primary account's (or the local file's), so single-account code keeps working.
  accounts?: AccountQuota[];
  five_hour: UsageBucket;
  seven_day: UsageBucket;
  // Legacy, null on current plans; files written before the fetcher learned
  // `limits` have only this.
  seven_day_sonnet?: UsageBucket;
  limits?: UsageLimit[];
  extra_usage?: ExtraUsage | null;
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

// Today + 7d spend, aggregated from TimeseriesResponse (30 days).
export interface SpendAggregate {
  today: Record<string, number>;
  todayTotal: number;
  sevenDayTotal: number;
  dailyTotals: DailyTotal[]; // every bucket, oldest first
}
