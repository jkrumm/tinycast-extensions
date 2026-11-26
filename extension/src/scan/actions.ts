// The Tinycast side of a scan: pre-check, then hand over. A no-view command
// is ended as soon as the user launches another one, and an ADF batch takes
// minutes — so this only runs `scan-cli --check` (seconds) and starts the
// real scan as a detached process that reports through a notification.
// Impure parts are injected (see `command.ts`).

import { ScanMode } from "./escl";
import { parseCheckLine, parseResultLine } from "./parse";

export interface ScanCommandPorts {
  preferences(): { scanInbox?: string; scannerHost?: string };
  // Runs the CLI with these args; resolves with its stdout and never rejects
  // (a crash is an empty string).
  runCli(args: string[], timeoutMs: number): Promise<string>;
  // Starts the CLI detached with these args.
  spawnScan(args: string[]): void;
  hud(text: string): Promise<void>;
}

const HUD_WORDS: Record<ScanMode, string> = {
  feeder: "Scanning",
  fronts: "Scanning fronts",
  backs: "Scanning backs",
  flatbed: "Scanning flatbed",
  more: "Scanning more",
};

const CHECK_TIMEOUT_MS = 15_000;
// Filing copies a PDF to the inbox share.
const DIRECT_TIMEOUT_MS = 60_000;

export type DirectAction = "submit" | "discard";

// Submit Scan / Discard Scan: the CLI does it in a second or two without a
// scanner, and its one-line result is the HUD.
export async function runDirectCommand(
  action: DirectAction,
  ports: ScanCommandPorts,
): Promise<void> {
  const prefs = ports.preferences();
  const outDir = prefs.scanInbox?.trim();
  if (!outDir && action === "submit") {
    return ports.hud("Set the scan inbox in the extension preferences");
  }
  const args = [
    `--${action}`,
    ...(outDir ? ["--out-dir", outDir] : []),
    "--no-notify",
  ];
  const result = parseResultLine(await ports.runCli(args, DIRECT_TIMEOUT_MS));
  return ports.hud(result.message);
}

export function scanArgs(
  mode: ScanMode,
  prefs: { scanInbox?: string; scannerHost?: string },
): string[] | null {
  const outDir = prefs.scanInbox?.trim();
  if (!outDir) return null;
  const host = prefs.scannerHost?.trim();
  return [
    "--mode",
    mode,
    "--out-dir",
    outDir,
    ...(host ? ["--host", host] : []),
  ];
}

export async function runScanCommand(
  mode: ScanMode,
  ports: ScanCommandPorts,
): Promise<void> {
  const args = scanArgs(mode, ports.preferences());
  if (!args)
    return ports.hud("Set the scan inbox in the extension preferences");
  const check = parseCheckLine(
    await ports.runCli(["--check", ...args], CHECK_TIMEOUT_MS),
  );
  if (!check.ok) return ports.hud(check.message);
  ports.spawnScan(args);
  return ports.hud(`${HUD_WORDS[mode]} - a notification follows`);
}
