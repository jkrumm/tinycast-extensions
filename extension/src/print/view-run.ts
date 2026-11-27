// The impure half of the printer view: every call into `print-cli` (the status,
// the cancels, the print of a form) and the Finder selection. The component
// (`printer.tsx`) and its form only call these, so the e2e suite mocks this one
// module.

import { runBunScript } from "../lib/bun-cli";
import {
  ActionResult,
  cancelAllPrints,
  printerFlags,
  printPaths,
} from "./actions";
import { PRINT_CLI, printPorts } from "./cli-run";
import { selectedFinderPaths } from "./finder";
import { Sides } from "./options";
import { parseCliResult, parsePrinterView, PrinterView } from "./parse";
import { formArgs, PrintFormValues } from "./view";

const STATUS_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 150_000;

export async function loadPrinter(): Promise<PrinterView> {
  const flags = printerFlags(printPorts.preferences());
  return parsePrinterView(
    await runBunScript(PRINT_CLI, ["--status", ...flags], STATUS_TIMEOUT_MS),
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
): Promise<ActionResult> {
  return printPaths(sides, paths, printPorts);
}

export async function cancelJob(jobId: string): Promise<ActionResult> {
  return parseCliResult(
    await runBunScript(PRINT_CLI, ["--cancel", jobId], ACTION_TIMEOUT_MS),
  );
}

export function cancelAll(): Promise<ActionResult> {
  return cancelAllPrints(printPorts);
}

export async function printFile(
  values: PrintFormValues,
): Promise<ActionResult> {
  const args = formArgs(values);
  if (!args.ok) return { ok: false, message: args.message };
  const flags = printerFlags(printPorts.preferences());
  return parseCliResult(
    await runBunScript(PRINT_CLI, [...args.value, ...flags], ACTION_TIMEOUT_MS),
  );
}
