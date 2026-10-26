// IU API budget: the rolling 30-day $500 cap, as IU's own portal reports it.
// usage-tracker's portal scraper writes ~/.local/share/iu-portal/latest.json on
// this Mac; this module reads and validates it (fs only, no network) and
// derives everything the surfaces show. Everything below `loadIuBudget` is
// pure. Age is the failure signal: an expired portal session leaves the old
// file in place.

import { readFile } from "fs/promises";
import { homedir } from "os";

export const IU_BUDGET_FILE = `${homedir()}/.local/share/iu-portal/latest.json`;
const SCHEMA = 1;

export const WARN_PCT = 80;
export const STALE_HOURS = 8;
export const DEAD_HOURS = 48;

export const MISSING_TEXT =
  "IU budget: no data — run `make iu-portal-login` in usage-tracker";
export const BAD_SCHEMA_TEXT = "IU budget: unknown format";

export interface IuDay {
  day: string;
  usd: number;
}

export interface IuBudgetData {
  fetchedAt: number; // epoch ms
  limitUsd: number;
  windowDays: number;
  rolling30Usd: number;
  canSpendTodayUsd: number;
  daily: IuDay[];
  topModels: { label: string; usd: number }[];
  dropoffNext7: { day: string; freesUsd: number }[];
}

export type IuBudgetReading =
  | { kind: "ok"; data: IuBudgetData }
  | { kind: "missing" }
  | { kind: "bad-schema" }
  | { kind: "invalid"; reason: string };

export type BudgetState = "ok" | "warn" | "over";
export type Freshness = "fresh" | "stale" | "dead";

export interface IuBudgetView {
  data: IuBudgetData;
  percent: number;
  state: BudgetState;
  freshness: Freshness;
  ageMs: number;
  freesNext7Usd: number;
  perDayUsd: number; // limit spread evenly over the window
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function list<T>(v: unknown, pick: (item: Obj) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const item of v) {
    const picked = isObj(item) ? pick(item) : null;
    if (picked === null) return null;
    out.push(picked);
  }
  return out;
}

export function parseIuBudget(raw: unknown): IuBudgetReading {
  if (!isObj(raw)) return { kind: "invalid", reason: "not an object" };
  if (raw.schema !== SCHEMA) return { kind: "bad-schema" };

  const fetchedAt = isStr(raw.fetched_at) ? Date.parse(raw.fetched_at) : NaN;
  if (!isNum(fetchedAt)) return { kind: "invalid", reason: "fetched_at" };
  if (!isNum(raw.limit_usd) || raw.limit_usd <= 0)
    return { kind: "invalid", reason: "limit_usd" };
  if (!isNum(raw.window_days) || raw.window_days <= 0)
    return { kind: "invalid", reason: "window_days" };
  if (!isNum(raw.rolling30_usd))
    return { kind: "invalid", reason: "rolling30_usd" };
  if (!isNum(raw.can_spend_today_usd))
    return { kind: "invalid", reason: "can_spend_today_usd" };

  const daily = list(raw.daily, (d) =>
    isStr(d.day) && isNum(d.usd) ? { day: d.day, usd: d.usd } : null,
  );
  if (!daily) return { kind: "invalid", reason: "daily" };
  const topModels = list(raw.top_models, (m) =>
    isStr(m.label) && isNum(m.usd) ? { label: m.label, usd: m.usd } : null,
  );
  if (!topModels) return { kind: "invalid", reason: "top_models" };
  const dropoffNext7 = list(raw.dropoff_next7, (d) =>
    isStr(d.day) && isNum(d.frees_usd)
      ? { day: d.day, freesUsd: d.frees_usd }
      : null,
  );
  if (!dropoffNext7) return { kind: "invalid", reason: "dropoff_next7" };

  return {
    kind: "ok",
    data: {
      fetchedAt,
      limitUsd: raw.limit_usd,
      windowDays: raw.window_days,
      rolling30Usd: raw.rolling30_usd,
      canSpendTodayUsd: raw.can_spend_today_usd,
      daily,
      topModels,
      dropoffNext7,
    },
  };
}

// Never throws: a missing or unreadable file is a reading, not an error.
export async function loadIuBudget(
  file: string = IU_BUDGET_FILE,
): Promise<IuBudgetReading> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid", reason: "unreadable" };
  }
  try {
    return parseIuBudget(JSON.parse(text));
  } catch {
    return { kind: "invalid", reason: "not JSON" };
  }
}

export function budgetState(percent: number): BudgetState {
  if (percent > 100) return "over";
  return percent >= WARN_PCT ? "warn" : "ok";
}

export function freshnessOf(ageMs: number): Freshness {
  const hours = ageMs / 3_600_000;
  if (hours > DEAD_HOURS) return "dead";
  return hours > STALE_HOURS ? "stale" : "fresh";
}

export function iuBudgetView(
  data: IuBudgetData,
  nowMs: number = Date.now(),
): IuBudgetView {
  const percent = (data.rolling30Usd / data.limitUsd) * 100;
  const ageMs = Math.max(0, nowMs - data.fetchedAt);
  return {
    data,
    percent,
    state: budgetState(percent),
    freshness: freshnessOf(ageMs),
    ageMs,
    freesNext7Usd: data.dropoffNext7.reduce((sum, d) => sum + d.freesUsd, 0),
    perDayUsd: data.limitUsd / data.windowDays,
  };
}

// Text for a reading that has no numbers; null when there are some.
export function unavailableText(r: IuBudgetReading): string | null {
  if (r.kind === "ok") return null;
  if (r.kind === "missing") return MISSING_TEXT;
  if (r.kind === "bad-schema") return BAD_SCHEMA_TEXT;
  return r.reason === "unreadable"
    ? "IU budget: file unreadable"
    : `IU budget: unexpected data (${r.reason}) — run \`make iu-portal-login\` in usage-tracker`;
}

// ---- Text ------------------------------------------------------------------

export function usd0(v: number): string {
  const rounded = Math.round(Math.abs(v));
  return `${v < 0 ? "-" : ""}$${rounded}`;
}

export function formatAge(ageMs: number): string {
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function usageLine(v: IuBudgetView): string {
  return `${usd0(v.data.rolling30Usd)} / ${usd0(v.data.limitUsd)} (${Math.round(v.percent)} %)`;
}

export function canSpendLine(v: IuBudgetView): string {
  const amount = v.data.canSpendTodayUsd;
  return amount < 0
    ? `Over the cap by ${usd0(-amount)} — spend nothing today`
    : `Can spend today: ${usd0(amount)}`;
}

export function freesLine(v: IuBudgetView): string | null {
  return v.freesNext7Usd > 0
    ? `Frees ${usd0(v.freesNext7Usd)} over the next 7 days`
    : null;
}

// "Updated 4h ago", with the warning once the number can't be trusted.
export function ageLine(v: IuBudgetView): string {
  const age = `Updated ${formatAge(v.ageMs)}`;
  if (v.freshness === "dead") return `${age} — portal session likely expired`;
  return v.freshness === "stale" ? `${age} (stale)` : age;
}

// "IU 116%"; a stale reading is "IU ~116%", a dead one claims no number.
function percentMark(v: IuBudgetView): string {
  if (v.freshness === "dead") return "IU ?";
  const pct = Math.round(v.percent);
  return v.freshness === "stale" ? `IU ~${pct}%` : `IU ${pct}%`;
}

// Menu-bar title suffix: only when the budget needs attention — or did at the
// last reading, which a dead one can no longer rule out. Empty otherwise: the
// existing title stays primary.
export function titleMark(v: IuBudgetView): string {
  return v.state === "ok" ? "" : percentMark(v);
}

// Hub tile status fragment (the tile has one short line).
export function tileFragment(r: IuBudgetReading, nowMs?: number): string {
  return r.kind === "ok" ? percentMark(iuBudgetView(r.data, nowMs)) : "IU —";
}

// A model's share of the window's spend; null when the window has none.
export function modelShare(v: IuBudgetView, usd: number): number | null {
  return v.data.rolling30Usd > 0
    ? Math.round((usd / v.data.rolling30Usd) * 100)
    : null;
}
