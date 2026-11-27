// Running a bundled bun script from a Tinycast command or view: one JSON line
// back (`runBunScript`), or a detached process that outlives the command
// (`spawnBunScript`). The scripts ship in assets/ (`make scan-cli`, `make
// print-cli`); bun comes from Homebrew, the PATH is set explicitly because a
// Tinycast no-view run has a minimal environment.

import { environment } from "@raycast/api";
import { execFile, spawn } from "child_process";

export const BUN_BIN = "/opt/homebrew/bin/bun";
export const PATH = "/opt/homebrew/bin:/usr/bin:/bin";

const scriptPath = (name: string): string =>
  `${environment.assetsPath}/${name}`;

// stdout of `bun <script> <args>`; never rejects (a crash is "").
export function runBunScript(
  name: string,
  args: string[],
  timeoutMs: number,
  maxBuffer = 1024 * 1024,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      BUN_BIN,
      [scriptPath(name), ...args],
      { timeout: timeoutMs, maxBuffer, env: { ...process.env, PATH } },
      (_error, stdout) => resolve(String(stdout ?? "")),
    );
  });
}

export function spawnBunScript(name: string, args: string[]): void {
  const child = spawn(BUN_BIN, [scriptPath(name), ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PATH },
  });
  child.unref?.();
}
