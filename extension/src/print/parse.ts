// Parsers for what the print CLI reads from CUPS and prints back. Pure.
//
// macOS localizes lpstat and lp whatever LC_ALL says (this Mac answers in
// German), so the printer state, the toner and the jobs come from `ipptool`
// output, whose attribute names and keywords are IPP and stay English. The
// two localized lines left are read by shape, not by words: the default
// destination is the text after the last colon, the request id is the
// `<queue>-<n>` token.

export type PrinterState = "idle" | "processing" | "stopped";

export interface PrinterStatus {
  state: PrinterState;
  accepting: boolean;
  reasons: string[];
  tonerPercent: number | null;
  tonerLow: boolean;
}

export const JOB_STATES = [
  "pending",
  "pending-held",
  "processing",
  "processing-stopped",
  "canceled",
  "aborted",
  "completed",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const ACTIVE_JOB_STATES: readonly JobState[] = [
  "pending",
  "pending-held",
  "processing",
  "processing-stopped",
];

export interface PrintJob {
  id: string; // `<queue>-<n>`, the id the CLI prints and cancel takes
  title: string;
  state: JobState;
  reasons: string[];
  user: string;
  submittedAt: number | null; // epoch seconds (CUPS' time-at-creation)
  sheets: number | null;
}

export interface IppAttribute {
  name: string;
  type: string;
  value: string;
}

export interface IppResult {
  passed: boolean;
  statusCode: string | null;
  // Response groups, one per job for Get-Jobs (split at `-- separator --`).
  groups: IppAttribute[][];
}

const RESULT_LINE = /\[(PASS|FAIL)\]\s*$/;
const ATTRIBUTE_LINE = /^\s{8}([a-z][a-z0-9-]*) \(([^)]*)\) = (.*)$/;
const STATUS_LINE = /^\s+status-code = (\S+)/;
const SEPARATOR_LINE = /^\s+-- separator --\s*$/;

// `ipptool -tv <uri> <test>`: the response starts after the `[PASS]`/`[FAIL]`
// line, so the request echo above it never counts as a result.
export function parseIpp(text: string): IppResult {
  const lines = text.split(/\r?\n/);
  const resultAt = lines.findIndex((line) => RESULT_LINE.test(line));
  if (resultAt < 0) return { passed: false, statusCode: null, groups: [] };

  const passed = /\[PASS\]\s*$/.test(lines[resultAt]);
  let statusCode: string | null = null;
  const groups: IppAttribute[][] = [[]];
  for (const line of lines.slice(resultAt + 1)) {
    const status = line.match(STATUS_LINE);
    if (status) statusCode = status[1];
    if (SEPARATOR_LINE.test(line)) groups.push([]);
    const attribute = line.match(ATTRIBUTE_LINE);
    if (attribute) {
      groups[groups.length - 1].push({
        name: attribute[1],
        type: attribute[2],
        value: attribute[3],
      });
    }
  }
  return {
    passed,
    statusCode,
    groups: groups.filter((group) => group.length > 0),
  };
}

const valueOf = (group: IppAttribute[], name: string): string | undefined =>
  group.find((attribute) => attribute.name === name)?.value;

const splitList = (value: string | undefined): string[] =>
  value ? value.split(",").map((item) => item.trim()) : [];

const PRINTER_STATES = ["idle", "processing", "stopped"] as const;

// The toner marker is the one whose type is `toner`. Negative levels are
// IPP's "unknown" and "unavailable" and read as no number.
export function parsePrinterStatus(text: string): PrinterStatus | null {
  const group = parseIpp(text).groups[0] ?? [];
  const state = valueOf(group, "printer-state") ?? "";
  if (!(PRINTER_STATES as readonly string[]).includes(state)) return null;
  const accepting = valueOf(group, "printer-is-accepting-jobs");
  const reasons = splitList(valueOf(group, "printer-state-reasons")).filter(
    (reason) => reason !== "none" && reason !== "",
  );

  const types = splitList(valueOf(group, "marker-types"));
  const index = types.length === 0 ? 0 : types.indexOf("toner");
  const level = numberAt(splitList(valueOf(group, "marker-levels")), index);
  const low = numberAt(splitList(valueOf(group, "marker-low-levels")), index);
  const tonerPercent = level !== null && level >= 0 ? level : null;
  const lowLevelReached =
    tonerPercent !== null && low !== null && low >= 0 && tonerPercent <= low;

  return {
    state: state as PrinterState,
    accepting: accepting === "true",
    reasons,
    tonerPercent,
    tonerLow: lowLevelReached || reasons.some((r) => r.startsWith("toner-low")),
  };
}

function numberAt(list: string[], index: number): number | null {
  if (index < 0) return null;
  const value = Number(list[index]);
  return list[index] === undefined || Number.isNaN(value) ? null : value;
}

// Jobs of a Get-Jobs or Get-Job-Attributes answer, one record per group.
export function parseJobs(text: string, printer: string): PrintJob[] {
  const jobs: PrintJob[] = [];
  for (const group of parseIpp(text).groups) {
    const state = valueOf(group, "job-state") ?? "";
    const number = valueOf(group, "job-id");
    if (!(JOB_STATES as readonly string[]).includes(state) || !number) {
      continue;
    }
    const created = Number(valueOf(group, "time-at-creation"));
    const sheets = Number(valueOf(group, "job-media-sheets-completed"));
    jobs.push({
      id: `${printer}-${number}`,
      title: valueOf(group, "job-name") ?? "",
      state: state as JobState,
      reasons: splitList(valueOf(group, "job-state-reasons")).filter(
        (reason) => reason !== "none",
      ),
      user: valueOf(group, "job-originating-user-name") ?? "",
      submittedAt: Number.isFinite(created) ? created : null,
      sheets: Number.isFinite(sheets) ? sheets : null,
    });
  }
  return jobs;
}

// `<queue>-<n>` back to its parts; null for anything else.
export function splitJobId(
  id: string,
): { printer: string; number: number } | null {
  const match = id.match(/^(.+)-(\d+)$/);
  if (!match) return null;
  return { printer: match[1], number: Number(match[2]) };
}

// `lpstat -d` in any language: the destination is the text after the colon.
export function parseDefaultDestination(stdout: string): string | null {
  const match = stdout.match(/:\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

// The `lp` answer, e.g. `request id is <queue>-<n> (1 file(s))`, in any
// language: only the `<queue>-<n>` token is read.
export function parseRequestId(stdout: string, printer: string): string | null {
  const escaped = printer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The German message joins queue and number with an en dash
  // ("Anfrage-ID ist <queue>\u2013<n>"), and LC_ALL=C does not switch it off.
  const match = stdout.match(
    new RegExp(`${escaped}[-\u2010-\u2015](\\d+)`, "u"),
  );
  return match ? `${printer}-${match[1]}` : null;
}

// One line of CLI output, read back defensively: anything that is not the
// documented JSON becomes a failure with `fallback`, never a thrown error.
export function parseJsonLine(stdout: string): Record<string, unknown> | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const PRINT_FAILED = "Print command failed";

export function parseCliResult(stdout: string): {
  ok: boolean;
  message: string;
} {
  const value = parseJsonLine(stdout);
  if (typeof value?.ok === "boolean" && typeof value.message === "string") {
    return { ok: value.ok, message: value.message };
  }
  return { ok: false, message: PRINT_FAILED };
}

export type PrinterView =
  | {
      ok: true;
      printer: string;
      state: PrinterState;
      accepting: boolean;
      reasons: string[];
      tonerPercent: number | null;
      tonerLow: boolean;
      jobs: PrintJob[];
    }
  | { ok: false; message: string };

const isString = (value: unknown): value is string => typeof value === "string";
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const isPrinterState = (value: unknown): value is PrinterState =>
  (PRINTER_STATES as readonly unknown[]).includes(value);
const isJobState = (value: unknown): value is JobState =>
  (JOB_STATES as readonly unknown[]).includes(value);

function decodeJob(value: Record<string, unknown>): PrintJob | null {
  const { id, title, state, reasons, user, submittedAt, sheets } = value;
  if (
    !isString(id) ||
    !isString(title) ||
    !isJobState(state) ||
    !isStringList(reasons) ||
    !isString(user) ||
    !isNumberOrNull(submittedAt) ||
    !isNumberOrNull(sheets)
  ) {
    return null;
  }
  return { id, title, state, reasons, user, submittedAt, sheets };
}

// The `--status` answer for the printer view. Anything it does not recognise
// is an error line, never a thrown exception or a half-filled view.
export function parsePrinterView(stdout: string): PrinterView {
  const value = parseJsonLine(stdout);
  if (value?.ok !== true) {
    const message = value?.message;
    return {
      ok: false,
      message:
        isString(message) && message
          ? message
          : "The print tool did not answer",
    };
  }
  const { printer, state, accepting, reasons, tonerPercent, tonerLow, jobs } =
    value;
  if (
    !isString(printer) ||
    !isPrinterState(state) ||
    typeof accepting !== "boolean" ||
    !isStringList(reasons) ||
    !isNumberOrNull(tonerPercent) ||
    typeof tonerLow !== "boolean" ||
    !Array.isArray(jobs)
  ) {
    return {
      ok: false,
      message: "The print tool answered in an unknown shape",
    };
  }
  const decoded = jobs.map((job: unknown) =>
    job !== null && typeof job === "object"
      ? decodeJob(job as Record<string, unknown>)
      : null,
  );
  return {
    ok: true,
    printer,
    state,
    accepting,
    reasons,
    tonerPercent,
    tonerLow,
    jobs: decoded.filter((job): job is PrintJob => job !== null),
  };
}
