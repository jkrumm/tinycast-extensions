// Pure: what the quota file says, turned into the three things the views show
// — the weekly limit (the one that matters on a Max plan), the 5h session, and
// any model-specific weekly caps — plus the weekly pace. No @raycast/api.

import { UsageQuotaOk } from "./types";

export interface QuotaWindow {
  label: string;
  percent: number | null; // 0-100
  resetsAt: number | null; // unix seconds
  // A model cap's size as a share of the weekly limit (Fable: 50).
  shareOfWeekly?: number | null;
}

export interface QuotaLimits {
  weekly: QuotaWindow;
  session: QuotaWindow;
  models: QuotaWindow[];
}

export const WEEK_SECONDS = 7 * 24 * 3600;

// weekly/session come from the legacy top-level buckets (fractional
// utilization, and every fetcher version writes them); model caps from the
// generic `limits` list, whatever models it names. A file written before the
// fetcher passed `limits` through falls back to `seven_day_sonnet`, only when
// it holds a value — current plans return null there.
export function quotaLimits(quota: UsageQuotaOk): QuotaLimits {
  const weekly: QuotaWindow = {
    label: "Weekly",
    percent: quota.seven_day.utilization,
    resetsAt: quota.seven_day.resets_at_epoch,
  };
  const session: QuotaWindow = {
    label: "5h session",
    percent: quota.five_hour.utilization,
    resetsAt: quota.five_hour.resets_at_epoch,
  };

  const models: QuotaWindow[] = quota.limits
    ? quota.limits
        .filter((limit) => limit.kind === "weekly_scoped")
        .map((limit) => ({
          label: limit.label ?? "Scoped",
          percent: limit.percent,
          resetsAt: limit.resets_at_epoch,
          shareOfWeekly: limit.allowance_percent_of_weekly,
        }))
    : quota.seven_day_sonnet?.utilization != null
      ? [
          {
            label: "Sonnet",
            percent: quota.seven_day_sonnet.utilization,
            resetsAt: quota.seven_day_sonnet.resets_at_epoch,
          },
        ]
      : [];

  return { weekly, session, models };
}

export type PaceStatus = "early" | "on-track" | "tight" | "ahead";

export interface WeeklyPace {
  elapsed: number; // 0-100: share of the week gone
  projected: number | null; // % at reset if usage keeps this rate; null while too early
  status: PaceStatus;
  runsOutAt: number | null; // unix seconds when 100 % is hit at this rate, before the reset
}

// Under ~6 h into the week one heavy session extrapolates to nonsense.
const MIN_ELAPSED_FOR_PROJECTION = 0.035;

// Linear projection over the rolling week: the window started 7 days before
// its reset; `used / elapsed` is the rate so far.
export function weeklyPace(
  weekly: QuotaWindow,
  nowSeconds: number,
): WeeklyPace | null {
  if (weekly.percent === null || weekly.resetsAt === null) return null;
  const start = weekly.resetsAt - WEEK_SECONDS;
  const fraction = Math.min(
    1,
    Math.max(0, (nowSeconds - start) / WEEK_SECONDS),
  );
  const elapsed = fraction * 100;
  if (fraction < MIN_ELAPSED_FOR_PROJECTION) {
    return { elapsed, projected: null, status: "early", runsOutAt: null };
  }

  const projected = weekly.percent / fraction;
  const status: PaceStatus =
    projected > 100 ? "ahead" : projected >= 90 ? "tight" : "on-track";
  const runsOutAt =
    status === "ahead" && weekly.percent > 0
      ? start + ((nowSeconds - start) * 100) / weekly.percent
      : null;
  return { elapsed, projected, status, runsOutAt };
}
