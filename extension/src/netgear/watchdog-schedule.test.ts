import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  shouldLogWatchdogEvent,
  shouldRunViewTick,
  startViewTicker,
} from "./watchdog-schedule";
import type { WatchdogEvent } from "./watchdog";

const NOW = 1_000_000;
const ev = (kind: WatchdogEvent["kind"]): WatchdogEvent => ({
  at: NOW,
  kind,
  message: kind,
});
const holder = (owner: "ui" | "watchdog", expiresAt = NOW + 60_000) => ({
  owner,
  label: "x",
  at: NOW,
  expiresAt,
});

describe("shouldLogWatchdogEvent", () => {
  it("skips routine kinds", () => {
    for (const kind of ["ok", "idle", "deferred", "in-progress"] as const) {
      expect(shouldLogWatchdogEvent(ev(kind), [])).toBe(false);
    }
  });

  it("logs non-routine kinds", () => {
    expect(shouldLogWatchdogEvent(ev("reconnect-failed"), [])).toBe(true);
  });

  it("logs only the first of a streak, ignoring in-progress breadcrumbs", () => {
    expect(shouldLogWatchdogEvent(ev("no-service"), [ev("ok")])).toBe(true);
    expect(
      shouldLogWatchdogEvent(ev("no-service"), [
        ev("in-progress"),
        ev("no-service"),
      ]),
    ).toBe(false);
  });
});

describe("shouldRunViewTick", () => {
  it("runs when enabled (or not yet loaded) and no manual action holds the lock", () => {
    expect(
      shouldRunViewTick({ enabled: true, lockHolder: null, now: NOW }),
    ).toBe(true);
    expect(
      shouldRunViewTick({ enabled: undefined, lockHolder: null, now: NOW }),
    ).toBe(true);
  });

  it("skips while paused", () => {
    expect(
      shouldRunViewTick({ enabled: false, lockHolder: null, now: NOW }),
    ).toBe(false);
  });

  it("skips while a ui action holds the lock, but not a stale or watchdog one", () => {
    const run = (lockHolder: ReturnType<typeof holder>) =>
      shouldRunViewTick({ enabled: true, lockHolder, now: NOW });
    expect(run(holder("ui"))).toBe(false);
    expect(run(holder("ui", NOW - 1))).toBe(true);
    expect(run(holder("watchdog"))).toBe(true);
  });
});

describe("startViewTicker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("first run after the delay, then every interval", async () => {
    const run = vi.fn(async () => {});
    const stop = startViewTicker({
      shouldRun: async () => true,
      run,
      intervalMs: 60_000,
      firstDelayMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops a slot while the previous run is still in flight", async () => {
    let release: () => void = () => {};
    const run = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const stop = startViewTicker({
      shouldRun: async () => true,
      run,
      intervalMs: 1_000,
      firstDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    stop();
  });

  it("skips a slot when shouldRun says no, and survives a failing run", async () => {
    let allowed = false;
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const stop = startViewTicker({
      shouldRun: async () => allowed,
      run,
      intervalMs: 1_000,
      firstDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).not.toHaveBeenCalled();
    allowed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });
});
