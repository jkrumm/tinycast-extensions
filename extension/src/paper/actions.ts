// The commands' core: each one runs a paper verb and returns its message for
// the HUD. The scan and print logic itself lives in paper; nothing here knows
// a scanner or a queue. Impure parts are injected.

import { RunPaper } from "./run";
import { PaperResult, parseResult } from "./result";

export type ScanMode = "feeder" | "fronts" | "backs" | "flatbed" | "more";
export type Sides = "two-sided" | "one-sided";

export const MAX_SELECTED_FILES = 5;
export const NOTHING_SELECTED = "Select a file in Finder first";

// A scan start checks the scanner first (discovery, state); a print submit
// waits on the queue check. Both are seconds.
const SCAN_TIMEOUT_MS = 60_000;
const PRINT_TIMEOUT_MS = 150_000;
const CANCEL_TIMEOUT_MS = 60_000;

const run = async (
  runPaper: RunPaper,
  args: string[],
  timeoutMs: number,
): Promise<PaperResult> => parseResult(await runPaper(args, timeoutMs));

export const scanStart = (mode: ScanMode, runPaper: RunPaper) =>
  run(runPaper, ["scan", "start", "--mode", mode], SCAN_TIMEOUT_MS);

export const scanSubmit = (runPaper: RunPaper) =>
  run(runPaper, ["scan", "submit"], SCAN_TIMEOUT_MS);

export const scanDiscard = (runPaper: RunPaper) =>
  run(runPaper, ["scan", "discard"], SCAN_TIMEOUT_MS);

// paper picks the edge itself (long edge, short edge for a landscape first
// page, one-sided for a one-sheet job); only one-sided is asked for.
export const sidesFlags = (sides: Sides): string[] =>
  sides === "one-sided" ? ["--simplex"] : [];

// One job per file, stopping at the first refusal so a stopped queue is
// reported once, not once per file.
export async function printPaths(
  sides: Sides,
  paths: string[],
  runPaper: RunPaper,
): Promise<PaperResult> {
  if (paths.length === 0) return { ok: false, message: NOTHING_SELECTED };
  if (paths.length > MAX_SELECTED_FILES) {
    return {
      ok: false,
      message: `Select at most ${MAX_SELECTED_FILES} files (${paths.length} selected)`,
    };
  }
  const messages: string[] = [];
  for (const path of paths) {
    const result = await run(
      runPaper,
      ["print", path, ...sidesFlags(sides)],
      PRINT_TIMEOUT_MS,
    );
    if (!result.ok) {
      const after = messages.length
        ? ` (${messages.length} of ${paths.length} submitted)`
        : "";
      return { ok: false, message: `${result.message}${after}` };
    }
    messages.push(result.message);
  }
  return {
    ok: true,
    message:
      messages.length === 1
        ? messages[0]
        : `Printing ${messages.length} files (${sides})`,
  };
}

export const cancelJob = (jobId: string, runPaper: RunPaper) =>
  run(runPaper, ["print", "cancel", jobId], CANCEL_TIMEOUT_MS);

export const cancelAllPrints = (runPaper: RunPaper) =>
  run(runPaper, ["print", "cancel", "--all"], CANCEL_TIMEOUT_MS);
