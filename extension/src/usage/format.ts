import { QuotaLimits, QuotaWindow, WeeklyPace, quotaLimits } from "./limits";
import { ExtraUsage, UsageBucket, UsageQuota, isQuotaError } from "./types";

export function formatUtilization(u: UsageBucket): string {
  return formatPercent(u.utilization);
}

export function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${Math.round(percent)}%`;
}

export function formatRelativeReset(
  epochSeconds: number | null,
  nowMs = Date.now(),
): string {
  if (epochSeconds === null) return "—";
  const diffMs = epochSeconds * 1000 - nowMs;
  if (diffMs <= 0) return "now";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Local wall-clock weekday + time, e.g. "Wed 18:00" — the weekly reset is a
// fixed point in the week, easier to plan around than "in 5d 2h".
export function formatWeekdayTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]} ${hh}:${mm}`;
}

export function formatSpend(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// "Fable" → "Fable weekly"; the label the API gives a scoped cap, never a
// hardcoded model.
export function modelLimitLabel(model: QuotaWindow): string {
  return `${model.label} weekly`;
}

// The pace in words: what the week ends at, or when it runs out.
export function formatPace(pace: WeeklyPace): string {
  if (pace.status === "early" || pace.projected === null)
    return "Too early to project";
  if (pace.status === "ahead" && pace.runsOutAt !== null)
    return `Ahead of pace — out ~${formatWeekdayTime(pace.runsOutAt)}`;
  const label = pace.status === "tight" ? "Tight" : "On track";
  return `${label} — ~${Math.round(pace.projected)}% at reset`;
}

// Menu-bar title: the bare weekly percent (the ring icon beside it is the
// weekly too). The 5h session is appended, labelled, only when it is the one
// about to bite.
export const SESSION_TITLE_THRESHOLD = 80;

export function menuBarTitle(quota: UsageQuota): string {
  if (isQuotaError(quota)) return "Claude: error";
  const { weekly, session } = quotaLimits(quota);
  const title = formatPercent(weekly.percent);
  return (session.percent ?? 0) >= SESSION_TITLE_THRESHOLD
    ? `${title} · 5h ${formatPercent(session.percent)}`
    : title;
}

// Hub tile status line (≤ ~18 characters): weekly first.
export function usageTileStatus(limits: QuotaLimits): string {
  return `7d ${formatPercent(limits.weekly.percent)} · 5h ${formatPercent(limits.session.percent)}`;
}

// Paid credits past the plan limits — only worth a line while switched on.
export function extraUsageLine(
  extra: ExtraUsage | null | undefined,
): string | null {
  if (!extra?.is_enabled) return null;
  const scale = 10 ** (extra.decimal_places ?? 2);
  const money = (minor: number | null) =>
    minor === null
      ? "—"
      : `${(minor / scale).toFixed(2)} ${extra.currency ?? ""}`.trim();
  return `Extra usage this month: ${money(extra.used_credits)} of ${money(extra.monthly_limit)}`;
}

// Model caps the status panel had no column left for.
export function overflowModelsLine(models: QuotaWindow[]): string | null {
  if (models.length === 0) return null;
  return models
    .map((m) => `${modelLimitLabel(m)} ${formatPercent(m.percent)}`)
    .join(" · ");
}
