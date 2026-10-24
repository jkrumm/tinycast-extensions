// Pure: Argo's `/agents/overview` quota payload → the accounts the views show,
// and the compact menu-bar title for several of them. No @raycast/api.

import { AccountQuota, UsageQuotaOk } from "./types";

// Per account, as pushed by agent-gateway (percent numbers, epoch seconds,
// null when unknown, updated_at epoch ms).
interface RawAccount {
  five_hour_pct?: number | null;
  seven_day_pct?: number | null;
  five_hour_resets_at?: number | null;
  seven_day_resets_at?: number | null;
  auth_ok?: boolean | null;
  exhausted_until?: number | null;
  enabled?: boolean | null;
  plan?: string | null;
  updated_at?: number | null;
}

// Argo's snapshot envelope: the agent-gateway `/api/overview` payload sits
// under `latest.snapshot`; `receivedAt` is ISO and lives on `latest`.
export interface OverviewResponse {
  latest: {
    id?: number | string;
    machine?: string;
    generatedAt?: number | string | null;
    receivedAt?: number | string | null;
    snapshot?: { quota?: { accounts?: Record<string, RawAccount> } } | null;
  } | null;
}

export const STALE_HINT_SECONDS = 15 * 60;

export const PRIMARY_ACCOUNT = "iu";

function toMs(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// Tolerate seconds or milliseconds for a timestamp field.
export function toSeconds(value: number | null | undefined): number | null {
  if (typeof value !== "number") return null;
  return value > 1e11 ? value / 1000 : value;
}

function freshness(...times: (number | null)[]): number {
  const known = times.filter((t): t is number => t !== null);
  return known.length > 0 ? Math.min(...known) : 0;
}

// Enabled accounts only, "iu" first. Null when the payload has no quota yet or
// nothing is enabled — the caller falls back to the local file.
export function accountsFromOverview(
  overview: OverviewResponse | null | undefined,
  nowSeconds = Date.now() / 1000,
): AccountQuota[] | null {
  const raw = overview?.latest?.snapshot?.quota?.accounts;
  if (!raw) return null;
  const receivedMs = toMs(overview?.latest?.receivedAt);

  const accounts = Object.entries(raw)
    .filter(([, a]) => a && a.enabled !== false)
    .map(([id, a]): AccountQuota => {
      const own = toSeconds(a.updated_at);
      const received = receivedMs === null ? null : receivedMs / 1000;
      const exhaustedUntil = toSeconds(a.exhausted_until);
      return {
        id,
        plan: a.plan ?? null,
        fiveHourPct: a.five_hour_pct ?? null,
        sevenDayPct: a.seven_day_pct ?? null,
        fiveHourResetsAt: toSeconds(a.five_hour_resets_at),
        sevenDayResetsAt: toSeconds(a.seven_day_resets_at),
        authOk: a.auth_ok !== false,
        exhaustedUntil:
          exhaustedUntil !== null && exhaustedUntil > nowSeconds
            ? exhaustedUntil
            : null,
        // Oldest known timestamp; unknown on both sides counts as infinitely old.
        updatedAt: freshness(own, received),
      };
    })
    .sort(
      (a, b) =>
        Number(b.id === PRIMARY_ACCOUNT) - Number(a.id === PRIMARY_ACCOUNT) ||
        a.id.localeCompare(b.id),
    );
  return accounts.length > 0 ? accounts : null;
}

// The single-account shape the views and the hub already read.
// `local` (the statusline's file, read only) lends the model caps and extra
// usage Argo does not carry.
export function primaryQuota(
  accounts: AccountQuota[],
  local?: UsageQuotaOk | null,
): UsageQuotaOk {
  const p = accounts[0];
  return {
    ...(local?.limits ? { limits: local.limits } : {}),
    ...(local?.seven_day_sonnet
      ? { seven_day_sonnet: local.seven_day_sonnet }
      : {}),
    ...(local?.extra_usage !== undefined
      ? { extra_usage: local.extra_usage }
      : {}),
    accounts,
    five_hour: {
      utilization: p.fiveHourPct,
      resets_at_epoch: p.fiveHourResetsAt,
    },
    seven_day: {
      utilization: p.sevenDayPct,
      resets_at_epoch: p.sevenDayResetsAt,
    },
    // The newest sample bounds how fresh the reading is; a lagging account is
    // flagged per account (accountFlags "stale"), not for the whole view.
    fetched_at: Math.max(...accounts.map((a) => a.updatedAt)),
  };
}

export type AccountFlag = "auth" | "exhausted" | "stale";

export function accountFlags(
  account: AccountQuota,
  staleAfterSeconds: number,
  nowSeconds = Date.now() / 1000,
): AccountFlag[] {
  const flags: AccountFlag[] = [];
  if (!account.authOk) flags.push("auth");
  if (account.exhaustedUntil !== null && account.exhaustedUntil > nowSeconds)
    flags.push("exhausted");
  if (nowSeconds - account.updatedAt > staleAfterSeconds) flags.push("stale");
  return flags;
}
