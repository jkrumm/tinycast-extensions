// "Scan More": the feeder sometimes stops mid-stack and the scanner reports a
// clean success (job Completed, ImagesCompleted = pages received, feeder
// empty), so the user reloads the rest and appends it to the last scan. The
// decisions live here, pure: what may be continued, whether the new pages are
// appended to the file still in the inbox or filed on their own, the message,
// and the state to keep for the next round. The fs work is in `job.ts`.

import { SCAN_MODES, ScanMode } from "./escl";

export const MORE_MAX_AGE_MS = 30 * 60 * 1000;

// The consumer holds this file in the inbox while it processes it.
export const CONSUMER_LOCK = ".fin-inbox.lock";

// What `last-scan.json` holds about the last scan delivered to the inbox.
export interface LastScan {
  mode: ScanMode; // never "more": a continued scan keeps the mode it continues
  fileName: string; // basename in the inbox
  path: string; // the file in the inbox
  pages: number; // pages in that file; `last-pages/` holds exactly these
  at: number;
  // The fronts page count a delivered backs scan was paired with
  // (`last-fronts.json` is gone by then), for the "(fronts had N)" note.
  frontsPages?: number;
}

export function parseLastScan(raw: unknown): LastScan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const mode = SCAN_MODES.find((m) => m === v.mode);
  if (!mode || mode === "more") return null;
  if (typeof v.fileName !== "string" || typeof v.path !== "string") return null;
  if (!Number.isInteger(v.pages) || (v.pages as number) < 1) return null;
  if (typeof v.at !== "number") return null;
  return {
    mode,
    fileName: v.fileName,
    path: v.path,
    pages: v.pages as number,
    at: v.at,
    frontsPages: Number.isInteger(v.frontsPages)
      ? (v.frontsPages as number)
      : undefined,
  };
}

export type Continuable =
  | { ok: true; last: LastScan }
  | {
      ok: false;
      message: string;
    };

// `jpegCount`: the JPEGs found in `last-pages/`.
export function checkContinuable(
  last: LastScan | null,
  jpegCount: number,
  nowMs: number,
): Continuable {
  if (!last || jpegCount !== last.pages) {
    return { ok: false, message: "Nothing to continue" };
  }
  if (nowMs - last.at >= MORE_MAX_AGE_MS) {
    return {
      ok: false,
      message: "Nothing to continue (the last scan is older than 30 minutes)",
    };
  }
  return { ok: true, last };
}

export type MorePlan =
  | { kind: "append" }
  | { kind: "separate"; reason: "picked-up" | "locked" | "not-replaceable" };

// Append only while the previous file is still in the inbox and the consumer
// is not processing the inbox; otherwise the new pages go in on their own.
export function planMore(env: {
  fileExists: boolean;
  lockExists: boolean;
}): MorePlan {
  if (env.lockExists) return { kind: "separate", reason: "locked" };
  if (!env.fileExists) return { kind: "separate", reason: "picked-up" };
  return { kind: "append" };
}

const pagesText = (n: number): string => `${n} page${n === 1 ? "" : "s"}`;

export interface MoreResult {
  message: string;
  // What `last-scan.json` becomes, so Scan More can be repeated.
  lastScan: LastScan;
  // `last-pages/`: the new JPEGs are added to the kept ones, or replace them.
  keepPages: "append" | "replace";
  // The fronts page count to write into `last-fronts.json` (continued fronts).
  frontsPages?: number;
}

export function moreResult(opts: {
  plan: MorePlan;
  last: LastScan;
  newPages: number;
  deliveredPath: string; // the file just delivered to the inbox
  deliveredName: string; // its basename
  nowMs: number;
}): MoreResult {
  const { plan, last, newPages, deliveredPath, deliveredName, nowMs } = opts;
  if (plan.kind === "separate") {
    const why =
      plan.reason === "not-replaceable"
        ? "the first part could not be replaced"
        : "the first part was already picked up";
    return {
      message: `${pagesText(newPages)} -> ${deliveredName} (${why})`,
      lastScan: {
        mode: "feeder",
        fileName: deliveredName,
        path: deliveredPath,
        pages: newPages,
        at: nowMs,
      },
      keepPages: "replace",
    };
  }
  const total = last.pages + newPages;
  const fronts =
    last.mode === "backs" &&
    last.frontsPages !== undefined &&
    last.frontsPages !== total
      ? ` (fronts had ${last.frontsPages})`
      : "";
  return {
    message: `${newPages} more ${newPages === 1 ? "page" : "pages"}, ${total} in total -> ${deliveredName}${fronts}`,
    lastScan: {
      mode: last.mode,
      fileName: deliveredName,
      path: deliveredPath,
      pages: total,
      at: nowMs,
      frontsPages: last.frontsPages,
    },
    keepPages: "append",
    frontsPages: last.mode === "fronts" ? total : undefined,
  };
}
