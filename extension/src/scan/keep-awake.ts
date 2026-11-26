// A scan run keeps the Mac awake: an ADF batch takes minutes and an idle
// sleep would end it halfway. `caffeinate -i -w <pid>` exits by itself when
// the scan process does. Failing to start it is logged, never fatal.

import { spawn as nodeSpawn } from "child_process";

const CAFFEINATE_BIN = "/usr/bin/caffeinate";

export interface KeepAwakeChild {
  unref(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnKeepAwake = (bin: string, args: string[]) => KeepAwakeChild;

const spawnDetached: SpawnKeepAwake = (bin, args) =>
  nodeSpawn(bin, args, { detached: true, stdio: "ignore" });

export function keepAwake(opts: {
  pid: number;
  log: (line: string) => void;
  spawn?: SpawnKeepAwake;
}): boolean {
  const spawnFn = opts.spawn ?? spawnDetached;
  try {
    const child = spawnFn(CAFFEINATE_BIN, ["-i", "-w", String(opts.pid)]);
    child.on("error", (error) =>
      opts.log(`caffeinate failed: ${error.message}`),
    );
    child.unref();
    return true;
  } catch (error) {
    opts.log(
      `caffeinate failed: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
}
