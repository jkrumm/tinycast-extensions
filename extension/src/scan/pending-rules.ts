// The pending scan, pure: what it is, what a scan start does with it, and the
// messages. A finished scan never goes straight to the inbox: the feeder of
// this device stops mid-stack and reports a clean success, the user needs
// several tries to push the rest through (Scan More), and the inbox consumer
// once filed an incomplete stack. So a scan stays pending, without expiry,
// until Submit Scan files it or Discard Scan drops it. The files are
// `pending.ts`, the orchestration `job.ts` and `filing.ts`.

import { frontsStemOf, SCAN_MODES, ScanMode } from "./escl";

// One scanned PDF waiting to be filed. A part's PDF and page JPEGs live in
// `pending/part-<n>/`.
export interface PendingPart {
  mode: Exclude<ScanMode, "more">; // a continued scan keeps its mode
  fileName: string; // the name it is filed under
  pages: number; // pages in the part's scan.pdf (and JPEGs)
  at: number; // when it was scanned (or last extended by Scan More)
}

// One part, or two: the fronts and the backs of a double-sided stack, which
// are filed and discarded together.
export interface Pending {
  parts: PendingPart[];
  // Set when the last Scan More failed (blank, incomplete, cancelled, refused):
  // sheets the user thinks are in the scan are not. The failure message; cleared
  // by the next successful scan or Scan More on it, by Submit and by Discard.
  attention?: string;
}

export function parsePending(raw: unknown): Pending | null {
  const list = (raw as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(list) || list.length < 1 || list.length > 2) return null;
  const parts: PendingPart[] = [];
  for (const entry of list) {
    const v = entry as Record<string, unknown> | null;
    const mode = SCAN_MODES.find((m) => m === v?.mode);
    if (!v || !mode || mode === "more") return null;
    if (typeof v.fileName !== "string" || !v.fileName) return null;
    if (!Number.isInteger(v.pages) || (v.pages as number) < 1) return null;
    if (typeof v.at !== "number") return null;
    parts.push({
      mode,
      fileName: v.fileName,
      pages: v.pages as number,
      at: v.at,
    });
  }
  if (
    parts.length === 2 &&
    (parts[0].mode !== "fronts" || parts[1].mode !== "backs")
  ) {
    return null;
  }
  const attention = (raw as { attention?: unknown }).attention;
  return typeof attention === "string" && attention
    ? { parts, attention }
    : { parts };
}

const withoutPeriod = (message: string): string =>
  message.replace(/[.!?]+$/, "");

// Submit Scan after a failed Scan More: refused unless forced.
export const submitRefusal = (attention: string): string =>
  `The last Scan More failed: ${withoutPeriod(attention)}. Scan those sheets again, or submit anyway`;

export type StartDecision =
  | { kind: "go" } // nothing in the way
  | { kind: "submit-first" } // file the pending scan, then scan
  | { kind: "append" } // Scan More: continue the last part
  | { kind: "refuse"; message: string };

// What a scan does with the pending scan when it starts. A new scan files the
// pending one first (a forgotten Submit is never lost and never blocks), except
// backs after fronts, which stay together as a pair.
export function startDecision(
  pending: Pending | null,
  mode: ScanMode,
): StartDecision {
  if (mode === "more") {
    return pending
      ? { kind: "append" }
      : {
          kind: "refuse",
          message: "Nothing to continue (the last scan is already filed)",
        };
  }
  if (mode === "backs") {
    if (pending?.parts.length === 2) {
      return {
        kind: "refuse",
        message: "The backs are already scanned. Submit Scan files both",
      };
    }
    return pending?.parts[0].mode === "fronts"
      ? { kind: "go" }
      : { kind: "refuse", message: "Scan the fronts first" };
  }
  return pending ? { kind: "submit-first" } : { kind: "go" };
}

// The name the backs are filed under: the stem of the pending fronts.
export const backsStem = (pending: Pending): string =>
  frontsStemOf(pending.parts[0].fileName);

const pagesText = (n: number): string => `${n} page${n === 1 ? "" : "s"}`;
const totalPages = (pending: Pending): number =>
  pending.parts.reduce((sum, part) => sum + part.pages, 0);

const frontsNote = (pending: Pending | null, pages: number): string =>
  pending?.parts.length === 2 && pending.parts[0].pages !== pages
    ? `fronts had ${pending.parts[0].pages}`
    : "";

// `pending`: the scan as it is after this scan was added.
export function scannedMessage(opts: {
  mode: ScanMode;
  pages: number;
  pending: Pending;
}): string {
  const { mode, pages } = opts;
  if (mode === "fronts") {
    return `${pagesText(pages)} scanned (fronts). Flip the stack, then Scan Backs.`;
  }
  if (mode === "backs") {
    const note = frontsNote(opts.pending, pages);
    return `${pagesText(pages)} scanned (backs${note ? `, ${note}` : ""}). Submit Scan to file both.`;
  }
  return `${pagesText(pages)} scanned. Scan More to append, Submit Scan to file it.`;
}

// `2 more pages, 19 in total.` — `pending` after the pages were appended.
export function moreMessage(opts: {
  newPages: number;
  total: number;
  pending: Pending;
}): string {
  const { newPages, total } = opts;
  const last = opts.pending.parts[opts.pending.parts.length - 1];
  const note = last.mode === "backs" ? frontsNote(opts.pending, total) : "";
  return `${newPages} more ${newPages === 1 ? "page" : "pages"}, ${total} in total${note ? ` (${note})` : ""}.`;
}

// `Filed: 19 pages -> a.pdf`, or both files of a pair.
export function filedMessage(
  filed: { pages: number; fileName: string }[],
): string {
  const pages = filed.map((f) => f.pages).join(" + ");
  const total = filed.reduce((sum, f) => sum + f.pages, 0);
  return `Filed: ${filed.length > 1 ? `${pages} pages` : pagesText(total)} -> ${filed
    .map((f) => f.fileName)
    .join(", ")}`;
}

export const discardedMessage = (pending: Pending): string =>
  pending.parts.length === 1
    ? `Discarded ${pagesText(totalPages(pending))}`
    : `Discarded ${pagesText(totalPages(pending))} (fronts and backs)`;

export const pendingPages = totalPages;
