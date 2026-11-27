// The printer view's pure parts: the words it shows, the poll rhythm, the hub
// tile and the cancel-all confirmation.
// No @raycast/api here, so the rules are unit-tested.

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
