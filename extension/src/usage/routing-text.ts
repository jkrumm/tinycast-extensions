// Pure text for the routing view: markdown tables for the Detail, plain lines
// for the menu-bar dropdown. No @raycast/api.

import { Eligibility, RoutingView, divergences, eligibility } from "./routing";
import { LANES, LanePick } from "./routing";
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

const pickCell = (p: LanePick | undefined) =>
  !p
    ? "—"
    : `${p.reason === "spill" ? "spill" : p.picked} (${reasonWords(p.reason)})${p.stale ? " — stale sample" : ""}`;

interface LaneRow {
  lanes: string[];
  mac: LanePick;
  mini: LanePick | undefined;
}

// Lanes that route the same way on both machines share a row.
function laneRows(view: Pick<RoutingView, "picks" | "argoPicks">): LaneRow[] {
  const rows: LaneRow[] = [];
  for (const lane of LANES) {
    const mac = view.picks?.find((p) => p.lane === lane);
    if (!mac) continue;
    const mini = view.argoPicks?.find((p) => p.lane === lane);
    const row = rows.find(
      (r) =>
        pickCell(r.mac) === pickCell(mac) &&
        pickCell(r.mini) === pickCell(mini),
    );
    if (row) row.lanes.push(lane);
    else rows.push({ lanes: [lane], mac, mini });
  }
  return rows;
}

// Detail: one row per group of lanes that route alike. With the mini's picks
// the table puts the two machines side by side and marks a row where they
// pick different accounts; without them it is this Mac only.
export function lanesTable(
  view: Pick<RoutingView, "picks" | "argoPicks">,
): string[] {
  if (!view.picks) return [];
  const label = (r: LaneRow) => r.lanes.map(laneLabel).join(", ");
  if (!view.argoPicks)
    return [
      "| Work | Goes to | Why |",
      "|-|-|-|",
      ...laneGroups(view.picks).map(
        (g) =>
          `| ${g.lanes.map(laneLabel).join(", ")} | ${g.account ?? "spill"} | ${reasonWords(g.reason)} |`,
      ),
    ];
  return [
    "| Work | This Mac | Mini |",
    "|-|-|-|",
    ...laneRows(view).map((r) => {
      const differs =
        r.mini !== undefined &&
        divergences(
          { local: null, argo: null, picks: [r.mac], argoPicks: [r.mini] },
          0,
        ).length > 0;
      return `| ${differs ? "⚠ " : ""}${label(r)} | ${pickCell(r.mac)} | ${pickCell(r.mini)} |`;
    }),
  ];
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
  if (!view.argoPicks)
    return "Mini picks unavailable — comparing eligibility only.";
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
  const lanes = lanesTable(view);
  if (lanes.length > 0) lines.push(...lanes, "");
  lines.push(...machinesTable(accounts, view, nowSeconds));
  const diverging = divergences(view, nowSeconds, laneLabel);
  if (diverging.length > 0) lines.push("", ...diverging.map((d) => `⚠️ ${d}`));
  const note = missingSideNote(view);
  if (note) lines.push("", `_${note}_`);
  return lines;
}
