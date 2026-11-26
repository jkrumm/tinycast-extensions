// The impure half of talking to `scan-cli` from a Tinycast command or view:
// run it for one JSON line, or start it detached. Shared by `command.ts` (the
// no-view commands) and `view-run.ts` (the Scanner view).

import { environment, getPreferenceValues } from "@raycast/api";
import { execFile, spawn } from "child_process";
import { Preferences } from "../lib/preferences";
import { ScanCommandPorts } from "./actions";

export const BUN_BIN = "/opt/homebrew/bin/bun";
export const PATH = "/opt/homebrew/bin:/usr/bin:/bin";

const cliPath = (): string => `${environment.assetsPath}/scan-cli.js`;

// stdout of `bun scan-cli.js <args>`; never rejects (a crash is "").
export function runCli(
  args: string[],
  timeoutMs: number,
  maxBuffer = 1024 * 1024,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      BUN_BIN,
      [cliPath(), ...args],
      { timeout: timeoutMs, maxBuffer, env: { ...process.env, PATH } },
      (_error, stdout) => resolve(String(stdout ?? "")),
    );
  });
}

export function spawnCli(args: string[]): void {
  const child = spawn(BUN_BIN, [cliPath(), ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PATH },
  });
  child.unref?.();
}

export const cliPorts: Omit<ScanCommandPorts, "hud"> = {
  preferences: () => getPreferenceValues<Preferences>(),
  runCli: (args, timeoutMs) => runCli(args, timeoutMs),
  spawnScan: spawnCli,
};
