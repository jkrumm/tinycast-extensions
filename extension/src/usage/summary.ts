// Pure: the one reading every Claude usage surface (menu-bar title, dropdown,
// Detail, hub tile) is built from — which account work goes to, how much of the
// combined weekly capacity is left, whether each account is on pace, and
// whether anything needs attention. No @raycast/api, no I/O.

import { AccountFlag, accountFlags } from "./accounts";
import { WeeklyPace, weeklyPace } from "./limits";
import {
  Eligibility,
  LANES,
  LanePick,
  RoutingView,
  eligibility,
  isSpill,
} from "./routing";
import { AccountQuota } from "./types";

// A sample older than this is worth a warning (the picker itself only stops
// trusting one at 6 h — usage/routing.ts MAX_SAMPLE_AGE_SECONDS).
export const STALE_ACCOUNT_SECONDS = 60 * 60;
// Pool headroom under this share of the combined weekly capacity is "low".
export const LOW_HEADROOM_PCT = 15;

// "max20x" → 20. A % of a 5x plan is a quarter of what the same % of a 20x
// plan is, so the pool weighs accounts by this.
export function planWeight(plan: string | null): number | null {
  const m = plan ? /(\d+)x/i.exec(plan) : null;
  return m ? Number(m[1]) : null;
}

export type Severity = "ok" | "low" | "broken" | "spill";

export interface AccountSummary {
  id: string;
  plan: string | null;
  weight: number; // plan multiple, or 1 for every account when any is unknown
  weeklyPct: number | null;
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null;
  weeklyResetsAt: number | null;
  pace: WeeklyPace | null;
  flags: AccountFlag[];
  ageSeconds: number; // age of the newest sample
  eligibility: Eligibility; // on this Mac
  working: boolean; // the account an interactive spawn goes to now
}

export interface Pool {
  usedPct: number; // weight-averaged weekly use, 0-100
  left: number; // capacity units left (a unit = one "x" of the plan)
  total: number;
  weighted: boolean; // false: a plan multiple was unknown, accounts counted equally
  elapsedPct: number | null; // weight-averaged share of the week gone
}

export interface UsageSummary {
  accounts: AccountSummary[];
  pool: Pool | null;
  working: string | null; // null while spilling or nothing is eligible
  severity: Severity;
  // One plain-words line: where work goes and what needs attention.
  headline: string;
  hasPicks: boolean; // false: `working` is estimated, this Mac's picker did not answer
}

function buildPool(accounts: AccountSummary[]): Pool | null {
  const known = accounts.filter((a) => a.weeklyPct !== null);
  if (known.length === 0) return null;
  const total = known.reduce((s, a) => s + a.weight, 0);
  const used = known.reduce((s, a) => s + a.weight * (a.weeklyPct ?? 0), 0);
  const paced = known.filter((a) => a.pace);
  const elapsedPct =
    paced.length === 0
      ? null
      : paced.reduce((s, a) => s + a.weight * (a.pace?.elapsed ?? 0), 0) /
        paced.reduce((s, a) => s + a.weight, 0);
  return {
    usedPct: used / total,
    left: (total * (100 - used / total)) / 100,
    total,
    weighted: known.every((a) => planWeight(a.plan) !== null),
    elapsedPct,
  };
}

// The interactive lane's pick when this Mac's picker answered; otherwise the
// eligible account with the most capacity left (an estimate — `hasPicks`).
function workingAccount(
  accounts: AccountSummary[],
  picks: LanePick[] | null,
): { id: string | null; spill: boolean; fromPicker: boolean } {
  const pick = picks?.find((p) => p.lane === "interactive");
  if (pick)
    return isSpill(pick)
      ? { id: null, spill: true, fromPicker: true }
      : { id: pick.picked, spill: false, fromPicker: true };
  const room = (a: AccountSummary) => a.weight * (100 - (a.weeklyPct ?? 100));
  const best = accounts
    .filter((a) => a.eligibility.eligible)
    .sort((a, b) => room(b) - room(a))[0];
  return { id: best?.id ?? null, spill: !best, fromPicker: false };
}

const pct = (p: number | null) => (p === null ? "—" : `${Math.round(p)}%`);

export function summarize(
  merged: AccountQuota[],
  routing: RoutingView | undefined,
  nowSeconds = Date.now() / 1000,
): UsageSummary {
  const weighted = merged.every((a) => planWeight(a.plan) !== null);
  const base = merged.map((a): Omit<AccountSummary, "working"> => ({
    id: a.id,
    plan: a.plan,
    weight: weighted ? (planWeight(a.plan) as number) : 1,
    weeklyPct: a.sevenDayPct,
    fiveHourPct: a.fiveHourPct,
    fiveHourResetsAt: a.fiveHourResetsAt,
    weeklyResetsAt: a.sevenDayResetsAt,
    pace: weeklyPace(
      {
        label: "Weekly",
        percent: a.sevenDayPct,
        resetsAt: a.sevenDayResetsAt,
      },
      nowSeconds,
    ),
    flags: accountFlags(a, STALE_ACCOUNT_SECONDS, nowSeconds),
    ageSeconds: nowSeconds - a.updatedAt,
    // This Mac's own verdict when it has one; Argo's accounts are merged in
    // `merged` already (usage/routing.ts mergeAccounts).
    eligibility: eligibility(a, nowSeconds),
  }));

  const picks = routing?.picks ?? null;
  const {
    id: working,
    spill,
    fromPicker,
  } = workingAccount(base as AccountSummary[], picks);
  const accounts = base.map((a): AccountSummary => ({
    ...a,
    working: a.id === working,
  }));
  const pool = buildPool(accounts);

  const broken = accounts.filter((a) => a.flags.length > 0);
  const severity: Severity = spill
    ? "spill"
    : broken.length > 0
      ? "broken"
      : pool && 100 - pool.usedPct < LOW_HEADROOM_PCT
        ? "low"
        : "ok";

  return {
    accounts,
    pool,
    working,
    severity,
    hasPicks: fromPicker,
    headline: headlineText({ accounts, pool, working, severity, broken }),
  };
}

// What is wrong with an account, in words, or null. A sample past the picker's
// 6 h limit names the age and says the account is skipped — that is the case
// that silently routes everything to the other accounts.
export function accountProblem(a: AccountSummary): string | null {
  if (a.flags.includes("auth")) return "login expired";
  if (a.flags.includes("exhausted")) return "exhausted";
  if (!a.eligibility.eligible && a.eligibility.reason?.startsWith("sample"))
    return `${a.eligibility.reason} — skipped`;
  if (a.flags.includes("stale")) return `sample ${ageText(a.ageSeconds)} old`;
  return null;
}

function ageText(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  return h >= 48 ? "days" : h >= 1 ? `${h}h` : `${Math.round(seconds / 60)}m`;
}

function headlineText(s: {
  accounts: AccountSummary[];
  pool: Pool | null;
  working: string | null;
  severity: Severity;
  broken: AccountSummary[];
}): string {
  const poolText = s.pool ? ` · pool ${pct(s.pool.usedPct)} used` : "";
  if (s.severity === "spill")
    return `No account has room — work spills${poolText}`;
  const where = s.working ? `Working on ${s.working}` : "No account to pick";
  if (s.severity === "broken") {
    const a = s.broken[0];
    return `${where} · ${a.id}: ${accountProblem(a)}${poolText}`;
  }
  if (s.severity === "low") return `${where} · low headroom${poolText}`;
  return `${where}${poolText}`;
}

// ---- Menu bar / hub tile ---------------------------------------------------

const SEVERITY_MARK: Record<Severity, string> = {
  ok: "",
  low: "▾",
  broken: "⚠",
  spill: "⊘",
};

// "me 9%" — the account work goes to and its own weekly use. Something to
// look at swaps the `%` for a leading mark so the title stays the same width:
// the bar behind the notch is full, and a title two characters wider pushes
// this item (and its neighbours) out of sight — exactly when it matters.
// Marks: ▾ low headroom, ⚠ a broken account, ⊘ spill.
export function menuBarTitle(s: UsageSummary): string {
  if (s.severity === "spill") return `${SEVERITY_MARK.spill}spill`;
  const w = s.accounts.find((a) => a.working);
  if (!w) return "—";
  const n = w.weeklyPct === null ? "—" : String(Math.round(w.weeklyPct));
  return s.severity === "ok"
    ? `${w.id} ${n}%`
    : `${SEVERITY_MARK[s.severity]}${w.id} ${n}`;
}

// Hub tile status (≤ ~18 characters).
export function summaryTileStatus(s: UsageSummary): string {
  const mark = SEVERITY_MARK[s.severity];
  const pool = s.pool ? ` · pool ${pct(s.pool.usedPct)}` : "";
  return s.severity === "spill"
    ? `${mark} spill${pool}`
    : `${mark}${mark ? " " : ""}${s.working ?? "—"}${pool}`;
}

// ---- Accounts --------------------------------------------------------------

// Where the week is heading, in a few words: "~12% at reset", "out Fri 14:00".
// `formatTime` renders an epoch as a weekday + time (usage/format.ts).
export function paceWords(
  pace: WeeklyPace | null,
  formatTime: (epochSeconds: number) => string,
): string {
  if (!pace || pace.projected === null) return "too early to project";
  if (pace.status === "ahead" && pace.runsOutAt !== null)
    return `out ${formatTime(pace.runsOutAt)}`;
  const at = pace.projected > 999 ? ">999" : String(Math.round(pace.projected));
  return `~${at}% at reset`;
}

// ---- Routing ---------------------------------------------------------------

export const LANE_LABEL: Record<string, string> = {
  interactive: "Interactive",
  wave: "Waves",
  fan: "Fan-outs",
  "agent-gateway:review": "Reviews",
  "agent-gateway:dispatch": "Dispatches",
  headless: "Headless",
};

export function laneLabel(lane: string): string {
  return LANE_LABEL[lane] ?? lane;
}

// The picker's reason in plain words.
export function reasonWords(reason: string): string {
  switch (reason) {
    case "home":
      return "home account";
    case "pace":
      return "home account ahead of pace";
    case "session":
      return "home account's 5h is full";
    case "spill":
      return "home account is full";
    case "no-eligible-account":
      return "no account has room";
    case "forced":
      return "forced";
    default:
      return reason;
  }
}

export interface LaneGroup {
  account: string | null; // null = spill
  reason: string;
  lanes: string[]; // lane ids, in LANES order
}

// Lanes sharing an account and reason collapse into one line: five of six
// lanes usually go the same way.
export function laneGroups(picks: LanePick[] | null): LaneGroup[] {
  if (!picks) return [];
  const order = (lane: string) => LANES.indexOf(lane as (typeof LANES)[number]);
  const groups: LaneGroup[] = [];
  for (const p of [...picks].sort((a, b) => order(a.lane) - order(b.lane))) {
    const account = isSpill(p) ? null : p.picked;
    const group = groups.find(
      (g) => g.account === account && g.reason === p.reason,
    );
    if (group) group.lanes.push(p.lane);
    else groups.push({ account, reason: p.reason, lanes: [p.lane] });
  }
  return groups;
}
