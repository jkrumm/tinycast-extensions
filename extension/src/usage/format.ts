import { UsageBucket, UsageQuota, isQuotaError } from "./types";

export function formatUtilization(u: UsageBucket): string {
  return u.utilization === null ? "—" : `${Math.round(u.utilization)}%`;
}

export function formatRelativeReset(epochSeconds: number | null): string {
  if (epochSeconds === null) return "—";
  const diffMs = epochSeconds * 1000 - Date.now();
  if (diffMs <= 0) return "now";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatSpend(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// Menu-bar title, e.g. "5h 12% · 7d 38%"
export function menuBarTitle(quota: UsageQuota): string {
  if (isQuotaError(quota)) return "Claude: error";
  return `5h ${formatUtilization(quota.five_hour)} · 7d ${formatUtilization(quota.seven_day)}`;
}
