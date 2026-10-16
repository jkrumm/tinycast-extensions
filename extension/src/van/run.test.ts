import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { environment } from "@raycast/api";
import { HELPER_FULL } from "./fixtures";
import { helperPath, readVan } from "./run";
import { configureVanRuntime, vanRuntime } from "./runtime";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "van-fake-helper-"));
  return () => rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.VAN_BLE_BIN;
});

// A stand-in for van-ble: swallows the key on stdin, prints one helper line.
function fakeHelper(output: unknown): string {
  const path = join(dir, "van-ble");
  writeFileSync(
    path,
    `#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify(output)}'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("the helper path", () => {
  it("is the bundled copy unless VAN_BLE_BIN overrides it", () => {
    expect(helperPath()).toBe(join(environment.assetsPath, "van-ble"));
    process.env.VAN_BLE_BIN = "/opt/signed/van-ble";
    expect(helperPath()).toBe("/opt/signed/van-ble");
  });

  it("with no override and no bundled copy it throws instead of resolving van-ble on PATH", async () => {
    const original = vanRuntime();
    configureVanRuntime(() => ({ ...original, assetsDir: "" }));
    try {
      expect(() => helperPath()).toThrow(/VAN_BLE_BIN/);
      await expect(readVan()).rejects.toThrow(/VAN_BLE_BIN/);
    } finally {
      configureVanRuntime(() => original);
    }
  });

  it("readVan spawns the overridden binary and parses its line", async () => {
    process.env.VAN_BLE_BIN = fakeHelper(HELPER_FULL);
    const { helper, keyMissing } = await readVan();
    expect(helper.battery?.name).toBe(HELPER_FULL.battery?.name);
    expect(helper.victron?.decryptedHex).toBe(
      HELPER_FULL.victron?.decryptedHex,
    );
    expect(keyMissing).toBe(false);
  });

  it("a missing override binary rejects instead of falling back", async () => {
    process.env.VAN_BLE_BIN = join(dir, "does-not-exist");
    await expect(readVan()).rejects.toThrow();
  });
});
