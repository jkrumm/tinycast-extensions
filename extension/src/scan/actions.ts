// The Tinycast side of a scan: pre-check, then hand over. A no-view command
// is ended as soon as the user launches another one, and an ADF batch takes
// minutes — so this only runs `scan-cli --check` (seconds) and starts the
// real scan as a detached process that reports through a notification.
// Impure parts are injected (see `command.ts`).

import { ScanMode } from "./escl";
import { parseCheckLine } from "./parse";

export interface ScanCommandPorts {
  preferences(): { scanInbox?: string; scannerHost?: string };
  // Runs the CLI with `--check` and these args; resolves with its stdout and
  // never rejects (a crash is an empty string).
  runCheck(args: string[]): Promise<string>;
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
  const check = parseCheckLine(await ports.runCheck(["--check", ...args]));
  if (!check.ok) return ports.hud(check.message);
  ports.spawnScan(args);
  return ports.hud(`${HUD_WORDS[mode]} - a notification follows`);
}
