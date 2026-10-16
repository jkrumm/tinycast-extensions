// Smoke test of the launchd entry (scripts/van-sampler.ts) as a real bun
// process: a fake helper script stands in for van-ble, the state and support
// dirs are tmp. The Victron key is resolved from the Keychain only (a miss is
// "no solar decode") and goes to the fake helper's stdin, never to the output.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HELPER_FULL } from "./fixtures";

const hasBun = spawnSync("bun", ["--version"]).status === 0;
const ENTRY = join(__dirname, "../../scripts/van-sampler.ts");
const dirs: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() =>
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

function run(opts: { helperOutput?: unknown; paused?: boolean }) {
  const stateDir = tmp("van-entry-state-");
  const supportDir = tmp("van-entry-support-");
  const bin = join(tmp("van-entry-bin-"), "van-ble");
  writeFileSync(
    bin,
    `#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify(opts.helperOutput ?? HELPER_FULL)}'\n`,
  );
  chmodSync(bin, 0o755);
  if (opts.paused) writeFileSync(join(stateDir, "paused"), "1");
  const result = spawnSync("bun", [ENTRY], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      VAN_SAMPLER_DIR: stateDir,
      VAN_SUPPORT_DIR: supportDir,
      VAN_BLE_BIN: bin,
    },
  });
  return { ...result, stateDir, supportDir };
}

describe.skipIf(!hasBun)("scripts/van-sampler.ts", () => {
  it("one run prints the subtitle, exits 0 and writes the state, the ring and the capture log", () => {
    const r = run({});
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^98 % · \d\d:\d\d$/);
    expect(existsSync(join(r.stateDir, "sampler.json"))).toBe(true);
    const ring = JSON.parse(
      readFileSync(join(r.stateDir, "van-history.json"), "utf8"),
    );
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatchObject({ soc: 98 });
    expect(readFileSync(join(r.supportDir, "van-log.jsonl"), "utf8")).toContain(
      '"source":"background"',
    );
  });

  it("the pause flag file makes a run return at once", () => {
    const r = run({ paused: true });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("Paused");
    expect(existsSync(join(r.stateDir, "van-history.json"))).toBe(false);
  });

  it("nothing found is an outcome: exit 0, the subtitle says so, no ring file", () => {
    const r = run({
      helperOutput: { battery: null, victron: null, errors: ["bluetooth-off"] },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("Bluetooth off");
    expect(existsSync(join(r.stateDir, "van-history.json"))).toBe(false);
  });
});
