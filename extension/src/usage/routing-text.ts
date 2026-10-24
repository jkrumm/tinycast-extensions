// Pure text for the routing view: markdown tables for the Detail, plain lines
// for the menu-bar dropdown. No @raycast/api.

import { Eligibility, RoutingView, divergences, eligibility } from "./routing";
import { LaneGroup, laneGroups, laneLabel, reasonWords } from "./summary";
import { AccountQuota } from "./types";

const cell = (e: Eligibility | null) =>
  e === null ? "—" : e.eligible ? "✓ eligible" : `✗ ${e.reason}`;

function sideEligibility(
  side: AccountQuota[] | null,
  id: string,
  nowSeconds: number,
): Eligibility | null {
  const a = side?.find((x) => x.id === id);
  return a ? eligibility(a, nowSeconds) : null;
}

function groupLine(g: LaneGroup): string {
  const lanes = g.lanes.map(laneLabel).join(", ");
  return g.account === null
    ? `${lanes} → spill (${reasonWords(g.reason)})`
    : `${lanes} → ${g.account} (${reasonWords(g.reason)})`;
}

// Dropdown: one line per (account, reason) group of lanes.
export function laneLines(picks: RoutingView["picks"]): string[] {
  return laneGroups(picks).map(groupLine);
}

// Detail: every lane, the account it goes to and why, in plain words.
export function lanesTable(picks: RoutingView["picks"]): string[] {
  if (!picks) return [];
  const rows = laneGroups(picks).flatMap((g) =>
    g.lanes.map(
      (lane) =>
        `| ${laneLabel(lane)} | ${g.account ?? "spill"} | ${reasonWords(g.reason)} |`,
    ),
  );
  return ["| Work | Goes to | Why |", "|-|-|-|", ...rows];
}

// Detail: each account's verdict on both machines.
export function machinesTable(
  accounts: AccountQuota[],
  view: Pick<RoutingView, "local" | "argo"> | undefined,
  nowSeconds = Date.now() / 1000,
): string[] {
  return [
    "| Account | This Mac | Mini |",
    "|-|-|-|",
    ...accounts.map(
      (a) =>
        `| ${a.id} | ${cell(sideEligibility(view?.local ?? null, a.id, nowSeconds))} | ${cell(sideEligibility(view?.argo ?? null, a.id, nowSeconds))} |`,
    ),
  ];
}

// Why one side of the comparison is missing, when it is.
export function missingSideNote(view: RoutingView): string | null {
  if (!view.local) return "This Mac's picker is unavailable — routing unknown.";
  if (!view.argo)
    return "Mini state unavailable (Argo not reachable or stale).";
  return null;
}

// The whole routing block of the Detail.
export function routingMarkdown(
  accounts: AccountQuota[],
  view: RoutingView | undefined,
  nowSeconds = Date.now() / 1000,
): string[] {
  if (!view) return [];
  const lines: string[] = [];
  const lanes = lanesTable(view.picks);
  if (lanes.length > 0) lines.push(...lanes, "");
  lines.push(...machinesTable(accounts, view, nowSeconds));
  const diverging = divergences(view, nowSeconds);
  if (diverging.length > 0) lines.push("", ...diverging.map((d) => `⚠️ ${d}`));
  const note = missingSideNote(view);
  if (note) lines.push("", `_${note}_`);
  return lines;
}
