// Getting the pending scan out of the state dir: into the inbox (Submit Scan,
// and a new scan that files a forgotten one first) or into `discarded/`
// (Discard Scan). Everything here runs under the pending lock and re-reads the
// scan inside it, so two processes can never both file one scan. Nothing is
// ever filed on its own: there is no timer.

import { join } from "path";
import { deliverPdf } from "./deliver";
import {
  fail,
  failureBody,
  inboxProblem,
  JobDeps,
  JobOptions,
  JobResult,
  pagesText,
  scanRunning,
  shownPath,
} from "./job-types";
import {
  clearPending,
  discardPendingFiles,
  partPagePaths,
  partThumbPaths,
  partPdfPath,
  Progress,
  readPending,
  readProgress,
  withPendingLock,
} from "./pending";
import { discardedMessage, filedMessage, Pending } from "./pending-rules";

export type SubmitOutcome =
  | { kind: "none" } // nothing pending
  | { kind: "busy" } // a scan is running
  | { kind: "filed"; result: JobResult };

// Files every part of the pending scan, the fronts before the backs. A part
// the inbox cannot take is kept in `unsent/`; either way the pending scan is
// cleared, so nothing is filed twice.
export function submitPending(
  opts: JobOptions,
  deps: JobDeps,
  log: (line: string) => void,
): Promise<SubmitOutcome> {
  return withPendingLock(
    opts.stateDir,
    deps,
    async (): Promise<SubmitOutcome> => {
      const pending = readPending(opts.stateDir);
      if (!pending) return { kind: "none" };
      if (scanRunning(opts.stateDir, deps)) return { kind: "busy" };
      return {
        kind: "filed",
        result: await fileParts(opts, deps, log, pending),
      };
    },
  );
}

async function fileParts(
  opts: JobOptions,
  deps: JobDeps,
  log: (line: string) => void,
  pending: Pending,
): Promise<JobResult> {
  const keepDir = join(opts.stateDir, "unsent");
  const filed: { pages: number; fileName: string }[] = [];
  const kept: number[] = [];
  for (const [index, part] of pending.parts.entries()) {
    const delivery = await deliverPdf(deps.deliverFs, {
      src: partPdfPath(opts.stateDir, index),
      outDir: opts.outDir,
      keepDir,
      fileName: part.fileName,
    });
    if (delivery.kind === "kept") {
      log(`inbox copy failed (${delivery.error}); kept: ${delivery.path}`);
      kept.push(part.pages);
      continue;
    }
    log(`filed: ${delivery.path}`);
    filed.push({
      pages: part.pages,
      fileName: delivery.path.split("/").pop() ?? part.fileName,
    });
  }
  clearPending(opts.stateDir);

  if (kept.length === 0) return { ok: true, message: filedMessage(filed) };
  const total = kept.reduce((sum, n) => sum + n, 0);
  const unsent = `Scanned ${pagesText(total)} but the inbox is not reachable. PDF${kept.length > 1 ? "s" : ""} kept in ${shownPath(keepDir)}`;
  return fail(filed.length > 0 ? `${unsent}. ${filedMessage(filed)}` : unsent);
}

// Before a new scan (inside its lock): a pending scan nobody submitted is
// filed first, so a forgotten Submit is never lost and never blocks.
export async function submitBeforeScan(
  opts: JobOptions,
  deps: JobDeps,
  log: (line: string) => void,
): Promise<void> {
  log("pending scan: submitting it before the new scan");
  const out = await submitPending(opts, deps, log);
  if (out.kind !== "filed" || !opts.notify) return;
  const result = out.result;
  await deps.notify({
    title: "Scan",
    body: result.ok ? result.message : failureBody(result.message),
  });
}

// Submit Scan: the pending scan goes to the inbox. An inbox that is not there
// leaves it pending (the user is at the Mac and can mount the share).
export async function submitNow(
  opts: JobOptions,
  deps: JobDeps,
  log: (line: string) => void,
): Promise<JobResult> {
  const problem = inboxProblem(opts.outDir);
  if (problem) return problem;
  const out = await submitPending(opts, deps, log);
  if (out.kind === "filed") return out.result;
  return fail(
    out.kind === "busy" ? "A scan is already running" : "Nothing to submit",
  );
}

// Discard Scan: the PDFs move to `discarded/` (the newest five files stay).
export function discardPending(
  opts: JobOptions,
  deps: JobDeps,
  log: (line: string) => void,
): Promise<JobResult> {
  return withPendingLock(opts.stateDir, deps, (): JobResult => {
    const pending = readPending(opts.stateDir);
    if (!pending) return fail("Nothing to discard");
    if (scanRunning(opts.stateDir, deps)) {
      return fail("A scan is already running");
    }
    for (const kept of discardPendingFiles(opts.stateDir, pending)) {
      log(`discarded: ${kept}`);
    }
    return { ok: true, message: discardedMessage(pending) };
  });
}

export interface ScanStatus {
  pending: {
    parts: {
      mode: string;
      fileName: string;
      pages: number;
      at: number;
      pagePaths: string[];
      // Aligned to the pages; null where no thumbnail was made.
      thumbPaths: (string | null)[];
      pdfPath: string;
    }[];
    // true while a live process holds the scan lock
    scanning: boolean;
  } | null;
  // What the running scan reports; only while the scan lock is held.
  progress?: Progress;
}

// `--status`: the pending scan for a UI. No scanner, no side effects.
export function scanStatus(opts: JobOptions, deps: JobDeps): ScanStatus {
  const pending = readPending(opts.stateDir);
  const scanning = scanRunning(opts.stateDir, deps);
  const progress = scanning ? readProgress(opts.stateDir) : null;
  return {
    pending: pending
      ? {
          parts: pending.parts.map((part, index) => ({
            ...part,
            pagePaths: partPagePaths(opts.stateDir, index),
            thumbPaths: partThumbPaths(opts.stateDir, index, part.pages),
            pdfPath: partPdfPath(opts.stateDir, index),
          })),
          scanning,
        }
      : null,
    ...(progress ? { progress } : {}),
  };
}
