import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  acquireActionLock,
  readActionLock,
  tryAcquireActionLock,
} from "./action-lock";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "action-lock-"));
  path = join(dir, "netgear-action.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = { ttlMs: 10_000 };

describe("tryAcquireActionLock", () => {
  it("creates the lock file with owner, label and expiry", async () => {
    const lock = await tryAcquireActionLock({
      path,
      owner: "ui",
      label: "Reconnect",
      now: () => 1000,
      ...base,
    });
    expect(lock).not.toBeNull();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      owner: "ui",
      label: "Reconnect",
      at: 1000,
      expiresAt: 11_000,
    });
  });

  it("returns null while a live lock is held", async () => {
    await tryAcquireActionLock({
      path,
      owner: "watchdog",
      label: "tick",
      now: () => 1000,
      ...base,
    });
    const second = await tryAcquireActionLock({
      path,
      owner: "ui",
      label: "Reconnect",
      now: () => 5000,
      ...base,
    });
    expect(second).toBeNull();
  });

  it("replaces an expired lock", async () => {
    await tryAcquireActionLock({
      path,
      owner: "watchdog",
      label: "tick",
      now: () => 1000,
      ...base,
    });
    const lock = await tryAcquireActionLock({
      path,
      owner: "ui",
      label: "Reconnect",
      now: () => 11_001,
      ...base,
    });
    expect(lock?.owner).toBe("ui");
    expect((await readActionLock(path, () => 11_002))?.owner).toBe("ui");
  });

  it("replaces an unparseable file", async () => {
    await writeFile(path, "not json");
    const lock = await tryAcquireActionLock({
      path,
      owner: "ui",
      label: "x",
      ...base,
    });
    expect(lock).not.toBeNull();
  });

  it("release deletes the file, but only while the lock is still ours", async () => {
    const mine = await tryAcquireActionLock({
      path,
      owner: "watchdog",
      label: "tick",
      now: () => 1000,
      ...base,
    });
    // Someone took over after our lock expired.
    await writeFile(
      path,
      JSON.stringify({ owner: "ui", label: "x", at: 2000, expiresAt: 99_000 }),
    );
    await mine?.release();
    expect((await readActionLock(path, () => 3000))?.owner).toBe("ui");

    const ours = await tryAcquireActionLock({
      path,
      owner: "ui",
      label: "y",
      now: () => 100_000,
      ...base,
    });
    await ours?.release();
    expect(await readActionLock(path, () => 100_001)).toBeNull();
  });
});

describe("readActionLock", () => {
  it("returns null for a missing file", async () => {
    expect(await readActionLock(path)).toBeNull();
  });

  it("returns the holder while live and null once expired", async () => {
    await tryAcquireActionLock({
      path,
      owner: "watchdog",
      label: "tick",
      now: () => 1000,
      ...base,
    });
    expect((await readActionLock(path, () => 5000))?.label).toBe("tick");
    expect(await readActionLock(path, () => 11_001)).toBeNull();
  });
});

describe("acquireActionLock", () => {
  function clock() {
    let t = 1000;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  it("acquires immediately when free", async () => {
    const c = clock();
    const lock = await acquireActionLock({
      path,
      owner: "ui",
      label: "Reconnect",
      waitMs: 60_000,
      pollMs: 1000,
      ...c,
      ...base,
    });
    expect(lock.owner).toBe("ui");
  });

  it("waits for a foreign lock to expire, notifying once", async () => {
    const c = clock();
    await tryAcquireActionLock({
      path,
      owner: "watchdog",
      label: "tick",
      now: c.now,
      ttlMs: 5000,
    });
    const waits: string[] = [];
    const lock = await acquireActionLock({
      path,
      owner: "ui",
      label: "Reconnect",
      waitMs: 60_000,
      pollMs: 1000,
      onWait: (h) => waits.push(h.owner),
      ...c,
      ...base,
    });
    expect(waits).toEqual(["watchdog"]);
    expect(lock.owner).toBe("ui");
    expect(c.now()).toBeLessThan(1000 + 10_000);
  });

  it("waits for a foreign lock to be released", async () => {
    const c = clock();
    const held = await tryAcquireActionLock({
      path,
      owner: "watchdog",
      label: "tick",
      now: c.now,
      ttlMs: 600_000,
    });
    const lock = await acquireActionLock({
      path,
      owner: "ui",
      label: "Reconnect",
      waitMs: 60_000,
      pollMs: 1000,
      ...c,
      sleep: async (ms) => {
        await c.sleep(ms);
        await held?.release();
      },
      ...base,
    });
    expect(lock.owner).toBe("ui");
    expect(c.now()).toBe(2000);
  });

  it("takes over after waitMs when the foreign lock never clears", async () => {
    const c = clock();
    await tryAcquireActionLock({
      path,
      owner: "watchdog",
      label: "tick",
      now: c.now,
      ttlMs: 600_000,
    });
    const lock = await acquireActionLock({
      path,
      owner: "ui",
      label: "Reconnect",
      waitMs: 5000,
      pollMs: 1000,
      ...c,
      ...base,
    });
    expect(lock.owner).toBe("ui");
    expect((await readActionLock(path, c.now))?.owner).toBe("ui");
  });
});
