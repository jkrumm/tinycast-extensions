// The printer view's pure parts: the words it shows, the poll rhythm, the hub
// tile, the cancel-all confirmation, and the Form-to-CLI argument mapping.
// No @raycast/api here, so the rules are unit-tested.

import { Check, fail, ok } from "./options";
import {
  ACTIVE_JOB_STATES,
  JobState,
  PrinterState,
  PrinterView,
  PrintJob,
} from "./parse";

export const POLL_ACTIVE_MS = 3000;
export const POLL_IDLE_MS = 15_000;

const STATE_WORD: Record<PrinterState, string> = {
  idle: "Idle",
  processing: "Printing",
  stopped: "Stopped",
};

const JOB_WORD: Record<JobState, string> = {
  pending: "Waiting",
  "pending-held": "Held",
  processing: "Printing",
  "processing-stopped": "Stopped",
  canceled: "Cancelled",
  aborted: "Failed",
  completed: "Done",
};

export function printerTitle(view: PrinterView): string {
  if (!view.ok) return "Printer unavailable";
  if (!view.accepting) return "Not accepting jobs";
  return STATE_WORD[view.state];
}

export function tonerText(percent: number | null): string {
  return percent === null ? "toner unknown" : `toner ${percent} %`;
}

// The hub tile: one short line, state first, toner after it.
export function tileStatus(view: PrinterView): string {
  if (!view.ok) return "Offline";
  const state = view.accepting ? STATE_WORD[view.state] : "Not accepting";
  return view.tonerPercent === null
    ? state
    : `${state} · toner ${view.tonerPercent} %`;
}

export function hasActiveJob(view: PrinterView): boolean {
  return (
    view.ok &&
    (view.state === "processing" ||
      view.jobs.some((job) => ACTIVE_JOB_STATES.includes(job.state)))
  );
}

// Fast while a job is in flight, relaxed otherwise. The view is read locally
// (a bun call), so even the fast rhythm is cheap.
export function pollInterval(view: PrinterView | undefined): number {
  return view && hasActiveJob(view) ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

export function jobTitle(job: PrintJob): string {
  return job.title || job.id;
}

// "Printing · 14:05": the state word and the local time the job was submitted.
export function jobSubtitle(job: PrintJob): string {
  const word = JOB_WORD[job.state];
  return job.submittedAt === null
    ? word
    : `${word} · ${clock(job.submittedAt)}`;
}

export function clock(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function cancelAllConfirmation(count: number): {
  title: string;
  message: string;
} {
  return {
    title: `Cancel ${count} print job${count === 1 ? "" : "s"}?`,
    message: "Jobs that are waiting or printing are removed from the queue.",
  };
}

export interface PrintFormValues {
  file: string;
  pages: string;
  copies: string;
  sides: string;
  nUp: string;
  manualFeed: boolean;
}

// Form values to the print-cli argv (the printer flag is added by the caller).
// The CLI validates the values; this only maps them and refuses an empty file.
export function formArgs(values: PrintFormValues): Check<string[]> {
  const file = values.file.trim();
  if (!file) return fail("Choose a file to print");
  const pages = values.pages.trim();
  return ok([
    file,
    ...(pages ? ["--pages", pages] : []),
    "--copies",
    values.copies.trim() || "1",
    ...sidesArgs(values.sides),
    "--n-up",
    values.nUp,
    ...(values.manualFeed ? ["--manual-feed"] : []),
  ]);
}

function sidesArgs(sides: string): string[] {
  if (sides === "one-sided") return ["--simplex"];
  return sides === "two-sided-short-edge" ? ["--short-edge"] : [];
}

export const SIDES_OPTIONS: readonly { value: string; title: string }[] = [
  { value: "two-sided-long-edge", title: "Two-sided, long edge" },
  { value: "two-sided-short-edge", title: "Two-sided, short edge" },
  { value: "one-sided", title: "One-sided" },
];

export const N_UP_OPTIONS: readonly string[] = ["1", "2", "4", "6", "9", "16"];
