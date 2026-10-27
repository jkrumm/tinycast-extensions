// Pure: the "Sessions" health reading from `claude-account health --json` —
// are the logins on both machines alive and are the quota samples fresh. Parse,
// worst state, one-line titles, grouping by machine, and the allowlist for the
// fix command a row offers. No @raycast/api, no I/O (the runner is
// health-local.ts).

export type HealthState = "ok" | "warn" | "fail";
export type HealthMachine = "mini" | "macbook";

export interface HealthRow {
  machine: HealthMachine;
  id: string; // an account id, or "-" for a machine-level check
  check: string; // reach | login | quota | queue
  state: HealthState;
  detail: string;
  fix: string | null;
}

export interface HealthReport {
  state: HealthState;
  rows: HealthRow[];
}

// A health reading and when it was taken (epoch ms) — cached across runs.
export interface StampedHealth {
  report: HealthReport;
  fetchedAt: number;
}

// The command ssh-es to the peer, so the menu bar (2 m interval) re-asks at
// most this often.
export const HEALTH_MAX_AGE_MS = 5 * 60_000;

const STATES: readonly HealthState[] = ["ok", "warn", "fail"];
const MACHINES: readonly HealthMachine[] = ["mini", "macbook"];
const SEVERITY: Record<HealthState, number> = { ok: 0, warn: 1, fail: 2 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseRow(v: unknown): HealthRow | null {
  if (!isRecord(v)) return null;
  const { machine, id, check, state, detail, fix } = v;
  if (!MACHINES.includes(machine as HealthMachine)) return null;
  if (!STATES.includes(state as HealthState)) return null;
  if (typeof id !== "string" || typeof check !== "string") return null;
  if (typeof detail !== "string") return null;
  return {
    machine: machine as HealthMachine,
    id,
    check,
    state: state as HealthState,
    detail,
    fix: typeof fix === "string" && fix !== "" ? fix : null,
  };
}

// Null when the output is not a health report. The report state is recomputed
// from the rows, so a row the parser dropped cannot leave a stale "ok" behind.
export function parseHealth(stdout: string): HealthReport | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(json) || !Array.isArray(json.rows)) return null;
  const rows = json.rows.flatMap((r) => {
    const row = parseRow(r);
    return row ? [row] : [];
  });
  if (rows.length === 0 && json.rows.length > 0) return null;
  return { state: worstState(rows), rows };
}

// A persisted StampedHealth (JSON text), re-validated; null when unusable.
export function parseStampedHealth(raw: string): StampedHealth | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || typeof v.fetchedAt !== "number") return null;
    const report = parseHealth(JSON.stringify(v.report));
    return report ? { report, fetchedAt: v.fetchedAt } : null;
  } catch {
    return null;
  }
}

export function worstState(rows: Pick<HealthRow, "state">[]): HealthState {
  return rows.reduce<HealthState>(
    (worst, r) => (SEVERITY[r.state] > SEVERITY[worst] ? r.state : worst),
    "ok",
  );
}

export function isHealthFresh(
  stamped: StampedHealth | null,
  nowMs: number,
): stamped is StampedHealth {
  return !!stamped && nowMs - stamped.fetchedAt < HEALTH_MAX_AGE_MS;
}

export function problemRows(report: HealthReport): HealthRow[] {
  return report.rows
    .filter((r) => r.state !== "ok")
    .sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state]);
}

// "iu login ends in 6.6 d on mini"; a machine-level row has no account:
// "mini reach: ssh timed out".
export function rowTitle(r: HealthRow): string {
  return r.id === "-"
    ? `${r.machine} ${r.check}: ${r.detail}`
    : `${r.id} ${r.detail} on ${r.machine}`;
}

// One line for the whole report: the worst row, plus how many more.
export function healthTitle(report: HealthReport): string {
  const [worst, ...rest] = problemRows(report);
  if (!worst) return "All sessions healthy";
  return rest.length === 0
    ? rowTitle(worst)
    : `${rowTitle(worst)} (+${rest.length} more)`;
}

export function healthMark(state: HealthState): string {
  return state === "fail" ? "✕" : state === "warn" ? "!" : "";
}

// Rows grouped per machine, mini first; machines without rows are omitted.
export function groupByMachine(
  rows: HealthRow[],
): { machine: HealthMachine; rows: HealthRow[] }[] {
  return MACHINES.flatMap((machine) => {
    const own = rows.filter((r) => r.machine === machine);
    return own.length > 0 ? [{ machine, rows: own }] : [];
  });
}

// The only command a row's `fix` may run: `claude-relogin <id>` with an
// optional `--machine mini|macbook`. Returns the argv after the binary, or
// null for anything else — the string is split, never given to a shell.
const FIX = /^claude-relogin ([a-z0-9-]+)(?: --machine (mini|macbook))?$/;

export function parseFixCommand(fix: string | null): string[] | null {
  const m = fix === null ? null : FIX.exec(fix);
  if (!m) return null;
  return m[2] ? [m[1], "--machine", m[2]] : [m[1]];
}

// Detail view: the rows as markdown, one table per machine.
export function healthMarkdown(report: HealthReport): string[] {
  const lines = ["## Sessions", "", `**${healthTitle(report)}**`, ""];
  for (const { machine, rows } of groupByMachine(report.rows)) {
    lines.push(`**${machine}**`, "", "| | Check | Detail |", "|-|-|-|");
    for (const r of rows) {
      const who = r.id === "-" ? "—" : r.id;
      const detail = r.detail.replace(/[|\r\n]+/g, " ");
      lines.push(`| ${stateGlyph(r.state)} ${who} | ${r.check} | ${detail} |`);
    }
    lines.push("");
  }
  return lines;
}

function stateGlyph(state: HealthState): string {
  return state === "ok" ? "🟢" : state === "warn" ? "🟠" : "🔴";
}
