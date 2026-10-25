// Pure: how the account picker (dotfiles' `claude-account`, spec
// docs/claude-accounts.md §The picker) sees the two Max accounts. Eligibility
// is its rule v1.2 restated so the view can say *why* an account is out; the
// picks themselves always come from `claude-account pick --dry`, never from a
// reimplementation. No @raycast/api, no I/O.

import { AccountQuota } from "./types";
import { toSeconds } from "./accounts";

// Same constants as the picker (SESSION_LIMIT / WEEKLY_LIMIT / max sample age).
export const SESSION_LIMIT = 85;
export const WEEKLY_LIMIT = 90;
export const MAX_SAMPLE_AGE_SECONDS = 6 * 3600;

export const LANES = [
  "interactive",
  "wave",
  "fan",
  "agent-gateway:review",
  "agent-gateway:dispatch",
  "headless",
] as const;

export interface LanePick {
  lane: string;
  picked: string;
  reason: string; // home | pace | session | spill | forced | …
  stale?: boolean; // the mini's pick ran on an old quota sample (Argo only)
}

// What one machine knows: its accounts, and (this Mac only) what each lane
// would pick right now.
export interface RoutingView {
  local: AccountQuota[] | null;
  argo: AccountQuota[] | null;
  picks: LanePick[] | null;
  // What the mini's picker chose per lane (Argo `snapshot.quota.picks`); null
  // on a payload without the field — the views fall back to eligibility.
  argoPicks?: LanePick[] | null;
}

export interface Eligibility {
  eligible: boolean;
  reason: string | null; // first rule that rules the account out
}

const round = (p: number) => Math.round(p);

// enabled ∧ auth_ok ∧ not exhausted ∧ 5h < 85 ∧ 7d < 90 ∧ sample age < 6 h
// (enabled is a given: disabled accounts never reach AccountQuota).
export function eligibility(
  a: AccountQuota,
  nowSeconds = Date.now() / 1000,
): Eligibility {
  const out = (reason: string): Eligibility => ({ eligible: false, reason });
  if (!a.authOk) return out("login expired");
  if (a.exhaustedUntil !== null && a.exhaustedUntil > nowSeconds)
    return out("exhausted");
  if (a.fiveHourPct === null && a.sevenDayPct === null) return out("no sample");
  const ageH = (nowSeconds - a.updatedAt) / 3600;
  if (nowSeconds - a.updatedAt >= MAX_SAMPLE_AGE_SECONDS)
    return out(`sample ${Math.floor(ageH)}h old`);
  if (a.fiveHourPct !== null && a.fiveHourPct >= SESSION_LIMIT)
    return out(`5h ${round(a.fiveHourPct)}% ≥ ${SESSION_LIMIT}%`);
  if (a.sevenDayPct !== null && a.sevenDayPct >= WEEKLY_LIMIT)
    return out(`7d ${round(a.sevenDayPct)}% ≥ ${WEEKLY_LIMIT}%`);
  return { eligible: true, reason: null };
}

// `claude-account pick --dry --why` prints the shell line, then
// `# picked=iu reason=home stale=false`.
export function parsePickOutput(lane: string, stdout: string): LanePick | null {
  const m = /^# picked=(\S+) reason=(\S+)/m.exec(stdout);
  return m ? { lane, picked: m[1], reason: m[2] } : null;
}

// Argo's `snapshot.quota.picks = {lane: {picked, reason, stale}}` → LANES order.
// Null when absent or empty; unknown lanes are ignored.
export function parseArgoPicks(raw: unknown): LanePick[] | null {
  if (!raw || typeof raw !== "object") return null;
  const picks: LanePick[] = [];
  for (const lane of LANES) {
    const p = (raw as Record<string, unknown>)[lane] as
      { picked?: unknown; reason?: unknown; stale?: unknown } | undefined;
    if (p && typeof p.picked === "string" && typeof p.reason === "string")
      picks.push({
        lane,
        picked: p.picked,
        reason: p.reason,
        stale: p.stale === true,
      });
  }
  return picks.length > 0 ? picks : null;
}

interface RawLocalAccount {
  id?: string;
  plan?: string | null;
  enabled?: boolean | null;
  five_hour?: number | null;
  seven_day?: number | null;
  five_hour_resets_at?: number | null;
  seven_day_resets_at?: number | null;
  age_s?: number | null;
  auth_ok?: boolean | null;
  exhausted_until?: number | null;
}

// `claude-account usage --json` → this Mac's accounts. No sample at all
// (age_s null) is updatedAt 0, i.e. infinitely old.
export function parseLocalUsage(
  stdout: string,
  nowSeconds = Date.now() / 1000,
): AccountQuota[] | null {
  let parsed: { accounts?: RawLocalAccount[] };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const accounts = (parsed.accounts ?? [])
    .filter((a) => a.id && a.enabled !== false)
    .map((a): AccountQuota => {
      const exhausted = toSeconds(a.exhausted_until ?? null);
      return {
        id: a.id as string,
        plan: a.plan ?? null,
        fiveHourPct: a.five_hour ?? null,
        sevenDayPct: a.seven_day ?? null,
        fiveHourResetsAt: toSeconds(a.five_hour_resets_at ?? null),
        sevenDayResetsAt: toSeconds(a.seven_day_resets_at ?? null),
        authOk: a.auth_ok !== false,
        exhaustedUntil:
          exhausted !== null && exhausted > nowSeconds ? exhausted : null,
        updatedAt:
          typeof a.age_s === "number" ? Math.round(nowSeconds - a.age_s) : 0,
      };
    });
  return accounts.length > 0 ? accounts : null;
}

// The accounts the views show: per id the fresher numbers of the two machines
// (null percent never beats a number), but auth and exhaustion are this Mac's
// when it knows the account — that is what its spawns will hit. Argo-only ids
// (a Mac without a registry entry) come through unchanged. Primary first.
export function mergeAccounts(
  argo: AccountQuota[] | null,
  local: AccountQuota[] | null,
): AccountQuota[] {
  const ids = [
    ...new Set([...(argo ?? []), ...(local ?? [])].map((a) => a.id)),
  ];
  const merged = ids.map((id): AccountQuota => {
    const a = argo?.find((x) => x.id === id);
    const l = local?.find((x) => x.id === id);
    if (!a) return l as AccountQuota;
    if (!l) return a;
    const hasNumbers = (x: AccountQuota) =>
      x.fiveHourPct !== null || x.sevenDayPct !== null;
    const fresher =
      hasNumbers(l) && (!hasNumbers(a) || l.updatedAt >= a.updatedAt) ? l : a;
    return {
      ...fresher,
      plan: fresher.plan ?? a.plan ?? l.plan,
      authOk: l.authOk,
      exhaustedUntil: l.exhaustedUntil ?? a.exhaustedUntil,
    };
  });
  return merged.sort(
    (x, y) =>
      Number(y.id === "iu") - Number(x.id === "iu") || x.id.localeCompare(y.id),
  );
}

const sameRoute = (a: LanePick, b: LanePick) =>
  a.reason === "spill" || b.reason === "spill"
    ? a.reason === b.reason
    : a.picked === b.picked;

// Where the two machines disagree — the case that makes the MacBook route
// differently from the mini. With both machines' picks it is the picks that
// differ, lane by lane; without the mini's (an older Argo payload) it falls
// back to whether an account is eligible on one side only. `label` names a
// lane group in words (usage/summary.ts laneLabel).
export function divergences(
  view: Pick<RoutingView, "local" | "argo"> &
    Partial<Pick<RoutingView, "picks" | "argoPicks">>,
  nowSeconds = Date.now() / 1000,
  label: (lane: string) => string = (l) => l,
): string[] {
  if (view.picks && view.argoPicks) {
    // Lanes that split the same way share one line.
    const byRoute = new Map<string, string[]>();
    for (const mac of view.picks) {
      const mini = view.argoPicks.find((p) => p.lane === mac.lane);
      if (!mini || sameRoute(mac, mini)) continue;
      const to = (p: LanePick) => (p.reason === "spill" ? "spill" : p.picked);
      const route = `this Mac → ${to(mac)}, mini → ${to(mini)}`;
      byRoute.set(route, [...(byRoute.get(route) ?? []), label(mac.lane)]);
    }
    return [...byRoute].map(
      ([route, lanes]) => `${lanes.join(", ")}: ${route}`,
    );
  }
  if (!view.local || !view.argo) return [];
  const lines: string[] = [];
  for (const l of view.local) {
    const a = view.argo.find((x) => x.id === l.id);
    if (!a) continue;
    const le = eligibility(l, nowSeconds);
    const ae = eligibility(a, nowSeconds);
    if (le.eligible === ae.eligible) continue;
    lines.push(
      le.eligible
        ? `${l.id}: eligible on this Mac, not on the mini (${ae.reason})`
        : `${l.id}: eligible on the mini, not on this Mac (${le.reason})`,
    );
  }
  return lines;
}

// "iu (home)" / "spill" — spill means no account has room for a bulk lane:
// the caller falls back to its IU path (`rd` pauses instead).
export function pickText(p: LanePick): string {
  return p.reason === "spill" ? "spill" : `${p.picked} (${p.reason})`;
}
