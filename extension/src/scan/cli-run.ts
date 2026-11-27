// The impure half of talking to `scan-cli` from a Tinycast command or view:
// run it for one JSON line, or start it detached. Shared by `command.ts` (the
// no-view commands) and `view-run.ts` (the Scanner view).

import { getPreferenceValues } from "@raycast/api";
import { Preferences } from "../lib/preferences";
import { runBunScript, spawnBunScript } from "../lib/bun-cli";
import { ScanCommandPorts } from "./actions";

const SCAN_CLI = "scan-cli.js";

// stdout of `bun scan-cli.js <args>`; never rejects (a crash is "").
export function runCli(
  args: string[],
  timeoutMs: number,
  maxBuffer = 1024 * 1024,
): Promise<string> {
  return runBunScript(SCAN_CLI, args, timeoutMs, maxBuffer);
}

export function spawnCli(args: string[]): void {
  spawnBunScript(SCAN_CLI, args);
}

export const cliPorts: Omit<ScanCommandPorts, "hud"> = {
  preferences: () => getPreferenceValues<Preferences>(),
  runCli: (args, timeoutMs) => runCli(args, timeoutMs),
  spawnScan: spawnCli,
};
