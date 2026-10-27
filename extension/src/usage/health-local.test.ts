import { describe, expect, it, vi } from "vitest";
import { loadHealth, launchRelogin, HealthStore } from "./health-local";
import { HEALTH_MAX_AGE_MS, StampedHealth } from "./health";

const NOW = 1_792_880_000_000;
const out = JSON.stringify({
  state: "warn",
  rows: [
    {
      machine: "mini",
      id: "iu",
      check: "login",
      state: "warn",
      detail: "login ends in 6.6 d",
      fix: "claude-relogin iu --machine mini",
    },
  ],
});

function memoryStore(initial: StampedHealth | null) {
  let value = initial;
  const store: HealthStore = {
    read: async () => value,
    write: vi.fn(async (v: StampedHealth) => {
      value = v;
    }),
  };
  return store;
}

const stamped = (fetchedAt: number): StampedHealth => ({
  report: { state: "ok", rows: [] },
  fetchedAt,
});

describe("loadHealth", () => {
  it("asks `health --json` and caches the reading", async () => {
    const store = memoryStore(null);
    const run = vi.fn(async () => out);
    const got = await loadHealth(store, run, NOW);
    expect(run).toHaveBeenCalledWith(["health", "--json"]);
    expect(got?.report.state).toBe("warn");
    expect(store.write).toHaveBeenCalledWith(got);
  });

  it("serves a fresh cache without asking again", async () => {
    const cached = stamped(NOW - HEALTH_MAX_AGE_MS + 1_000);
    const run = vi.fn(async () => out);
    expect(await loadHealth(memoryStore(cached), run, NOW)).toBe(cached);
    expect(run).not.toHaveBeenCalled();
  });

  it("asks again once the cache is older than 5 minutes", async () => {
    const run = vi.fn(async () => out);
    const got = await loadHealth(
      memoryStore(stamped(NOW - HEALTH_MAX_AGE_MS - 1)),
      run,
      NOW,
    );
    expect(run).toHaveBeenCalledOnce();
    expect(got?.fetchedAt).toBe(NOW);
  });

  it("keeps the last reading when the command fails or prints junk", async () => {
    const old = stamped(NOW - 60 * 60_000);
    expect(
      await loadHealth(
        memoryStore(old),
        async () => {
          throw new Error("timeout");
        },
        NOW,
      ),
    ).toBe(old);
    expect(await loadHealth(memoryStore(old), async () => "junk", NOW)).toBe(
      old,
    );
    expect(
      await loadHealth(memoryStore(null), async () => "junk", NOW),
    ).toBeNull();
  });
});

describe("launchRelogin", () => {
  it("spawns claude-relogin with the split args", () => {
    const spawnFn = vi.fn();
    expect(launchRelogin("claude-relogin iu --machine mini", spawnFn)).toBe(
      true,
    );
    expect(spawnFn).toHaveBeenCalledOnce();
    const [bin, args] = spawnFn.mock.calls[0];
    expect(bin).toMatch(/\/\.local\/bin\/claude-relogin$/);
    expect(args).toEqual(["iu", "--machine", "mini"]);
  });

  it.each([
    null,
    "rm -rf /",
    "claude-relogin iu; reboot",
    "claude-relogin iu --machine nas",
    "claude-account usage",
  ])("rejects %j without spawning", (fix) => {
    const spawnFn = vi.fn();
    expect(launchRelogin(fix, spawnFn)).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
