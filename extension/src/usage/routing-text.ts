// Pure text for the routing view: markdown tables for the Detail, plain lines
// for the menu-bar dropdown. No @raycast/api.

import {
  formatPercent,
  formatRelativeReset,
  formatWeekdayTime,
} from "./format";
import {
  Eligibility,
  LANES,
  RoutingView,
  divergences,
  eligibility,
  pickText,
} from "./routing";
import { AccountQuota } from "./types";

const cell = (e: Eligibility | null) =>
  e === null ? "—" : e.eligible ? "✓" : `✗ ${e.reason}`;

function sideEligibility(
  side: AccountQuota[] | null,
  id: string,
  nowSeconds: number,
): Eligibility | null {
  const a = side?.find((x) => x.id === id);
  return a ? eligibility(a, nowSeconds) : null;
}

// Per account: both windows and whether each machine's picker would use it.
export function accountsTable(
  accounts: AccountQuota[],
  view: Pick<RoutingView, "local" | "argo"> | undefined,
  nowMs = Date.now(),
): string[] {
  const now = nowMs / 1000;
  const rows = accounts.map((a) => {
    const five = `${formatPercent(a.fiveHourPct)} · ${formatRelativeReset(a.fiveHourResetsAt, nowMs)}`;
    const seven =
      a.sevenDayResetsAt === null ? "—" : formatWeekdayTime(a.sevenDayResetsAt);
    return `| ${a.id} | ${five} | ${seven} | ${cell(sideEligibility(view?.local ?? null, a.id, now))} | ${cell(sideEligibility(view?.argo ?? null, a.id, now))} |`;
  });
  return [
    "| Account | 5h · resets in | 7d resets | This Mac | Mini |",
    "|-|-|-|-|-|",
    ...rows,
  ];
}

// What each lane would pick on this Mac, from `claude-account pick --dry`.
export function lanesTable(picks: RoutingView["picks"]): string[] {
  if (!picks) return [];
  const order = (lane: string) => LANES.indexOf(lane as (typeof LANES)[number]);
  return [
    "| Lane | Picks on this Mac |",
    "|-|-|",
    ...[...picks]
      .sort((a, b) => order(a.lane) - order(b.lane))
      .map((p) => `| ${p.lane} | ${pickText(p)} |`),
  ];
}

// The whole routing block of the Detail: both tables plus the divergence lines.
export function routingMarkdown(
  accounts: AccountQuota[],
  view: RoutingView | undefined,
  nowMs = Date.now(),
): string[] {
  const lines = accountsTable(accounts, view, nowMs);
  if (view) {
    const diverging = divergences(view, nowMs / 1000);
    if (diverging.length > 0)
      lines.push("", ...diverging.map((d) => `⚠️ ${d}`));
    if (!view.local)
      lines.push("", "_This Mac's picker is unavailable — routing unknown._");
    else if (!view.argo)
      lines.push("", "_Mini state unavailable (Argo not reachable or stale)._");
    const lanes = lanesTable(view.picks);
    if (lanes.length > 0) lines.push("", ...lanes);
  }
  return lines;
}

// Dropdown: one line per lane.
export function laneLines(picks: RoutingView["picks"]): string[] {
  return lanesTable(picks)
    .slice(2)
    .map((row) => row.replace(/^\| (.*) \| (.*) \|$/, "$1: $2"));
}

export function interactivePick(picks: RoutingView["picks"]): string | null {
  const p = picks?.find((x) => x.lane === "interactive");
  return p && p.reason !== "spill" ? p.picked : null;
}

// Dropdown line: both machines' verdict on one account.
export function eligibilityLine(
  a: AccountQuota,
  view: Pick<RoutingView, "local" | "argo"> | undefined,
  nowSeconds = Date.now() / 1000,
): string {
  return `This Mac ${cell(sideEligibility(view?.local ?? null, a.id, nowSeconds))} · Mini ${cell(sideEligibility(view?.argo ?? null, a.id, nowSeconds))}`;
}
