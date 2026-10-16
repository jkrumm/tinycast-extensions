import { describe, expect, it } from "vitest";
import { shouldLogWatchdogEvent } from "./watchdog-schedule";
import type { WatchdogEvent } from "./watchdog";

const NOW = 1_000_000;
const ev = (kind: WatchdogEvent["kind"]): WatchdogEvent => ({
  at: NOW,
  kind,
  message: kind,
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
