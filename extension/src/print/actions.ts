// The Tinycast side of printing: the Finder selection (no-view commands and the
// printer view) through `print-cli`, one job per file. Returns the message for
// the HUD or toast; the callers show it. Impure parts are injected.

import { Sides, sidesLabel } from "./options";
import { parseCliResult } from "./parse";

export interface PrintPorts {
  preferences(): { printQueue?: string };
  // Runs print-cli with these args; resolves with its stdout, never rejects.
  runCli(args: string[], timeoutMs: number): Promise<string>;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export const MAX_SELECTED_FILES = 5;
// A submit is seconds; the CLI's own ipptool and lp calls bound each step.
const PRINT_TIMEOUT_MS = 150_000;
const CANCEL_TIMEOUT_MS = 60_000;

export const NOTHING_SELECTED = "Select a file in Finder first";

// The print-cli flags for the sides; two-sided long edge is the CLI's default.
export function sidesFlags(sides: Sides): string[] {
  if (sides === "one-sided") return ["--simplex"];
  return sides === "two-sided-short-edge" ? ["--short-edge"] : [];
}

// `--printer <queue>` from the extension preference; empty means the default.
export function printerFlags(prefs: { printQueue?: string }): string[] {
  const queue = prefs.printQueue?.trim();
  return queue ? ["--printer", queue] : [];
}

// One job per file, stopping at the first refusal so a stopped queue is
// reported once, not once per file.
export async function printPaths(
  sides: Sides,
  paths: string[],
  ports: PrintPorts,
): Promise<ActionResult> {
  if (paths.length === 0) return { ok: false, message: NOTHING_SELECTED };
  if (paths.length > MAX_SELECTED_FILES) {
    return {
      ok: false,
      message: `Select at most ${MAX_SELECTED_FILES} files (${paths.length} selected)`,
    };
  }
  const flags = [...sidesFlags(sides), ...printerFlags(ports.preferences())];
  const messages: string[] = [];
  for (const path of paths) {
    const result = parseCliResult(
      await ports.runCli([path, ...flags], PRINT_TIMEOUT_MS),
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
        : `Printing ${messages.length} files (${sidesLabel(sides)})`,
  };
}

export async function cancelAllPrints(
  ports: PrintPorts,
): Promise<ActionResult> {
  const result = parseCliResult(
    await ports.runCli(
      ["--cancel-all", ...printerFlags(ports.preferences())],
      CANCEL_TIMEOUT_MS,
    ),
  );
  return result;
}
