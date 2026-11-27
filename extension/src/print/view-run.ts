// The impure half of the printer view: every call into paper (the status, the
// cancels, the print of the Finder selection). The component (`printer.tsx`)
// and the hub tile only call these, so the e2e suites mock this one module.

import {
  cancelAllPrints,
  cancelJob as cancelPaperJob,
  printPaths,
  Sides,
} from "../paper/actions";
import { PaperResult } from "../paper/result";
import { runPaper } from "../paper/run";
import { selectedFinderPaths } from "./finder";
import { parsePrinterView, PrinterView } from "./parse";

const STATUS_TIMEOUT_MS = 15_000;

export async function loadPrinter(): Promise<PrinterView> {
  return parsePrinterView(
    await runPaper(["print", "status"], STATUS_TIMEOUT_MS),
  );
}

// Read once when the view opens: Finder is frontmost then, not while the view
// is open, so the view keeps this list and never reads it again.
export async function loadSelection(): Promise<string[]> {
  return selectedFinderPaths();
}

export function printSelection(
  sides: Sides,
  paths: string[],
): Promise<PaperResult> {
  return printPaths(sides, paths, runPaper);
}

export function cancelJob(jobId: string): Promise<PaperResult> {
  return cancelPaperJob(jobId, runPaper);
}

export function cancelAll(): Promise<PaperResult> {
  return cancelAllPrints(runPaper);
}
