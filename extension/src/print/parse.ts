// The printer view's data: what `paper print status` prints, read back
// defensively. Pure. CUPS and its localisation traps live in paper.

import { parseJsonLine } from "../paper/result";

export type PrinterState = "idle" | "processing" | "stopped";

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
  id: string; // `<queue>-<n>`, the id `paper print cancel` takes
  title: string;
  state: JobState;
  reasons: string[];
  user: string;
  submittedAt: number | null; // epoch seconds (CUPS' time-at-creation)
  sheets: number | null;
}

const PRINTER_STATES = ["idle", "processing", "stopped"] as const;

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

// The `paper print status` answer. Anything it does not recognise is an error
// line, never a thrown exception or a half-filled view.
export function parsePrinterView(stdout: string): PrinterView {
  const value = parseJsonLine(stdout);
  if (value?.ok !== true) {
    const message = value?.message;
    return {
      ok: false,
      message: isString(message) && message ? message : "paper did not answer",
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
    return { ok: false, message: "paper answered in an unknown shape" };
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
