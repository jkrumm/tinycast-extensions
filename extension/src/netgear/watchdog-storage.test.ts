import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INITIAL_WATCHDOG_STATE, RebootMarker } from "./watchdog";
import {
  appendWatchdogEvent,
  consumeRebootMarker,
  loadWatchdogStorage,
  readPendingMarker,
  recordReboot,
  saveWatchdogStorage,
  setWatchdogEnabled,
} from "./watchdog-storage";

const marker = (at: number): RebootMarker => ({ at, source: "ui", iccid: "1" });
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wd-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("watchdog storage", () => {
  it("returns an enabled, empty default when nothing is on disk", () => {
    const s = loadWatchdogStorage(join(dir, "missing"));
    expect(s).toMatchObject({ enabled: true, events: [], since: null });
    expect(s.state).toEqual(INITIAL_WATCHDOG_STATE);
  });

  it("round-trips the tick's state and events", () => {
    const saved = appendWatchdogEvent(loadWatchdogStorage(dir), {
      at: 5,
      kind: "ok",
      message: "fine",
    });
    saveWatchdogStorage(saved, dir);
    const loaded = loadWatchdogStorage(dir);
    expect(loaded.events[0]).toMatchObject({ kind: "ok", message: "fine" });
    expect(loaded.counts).toEqual(saved.counts);
  });

  it("survives a corrupt state file", () => {
    writeFileSync(join(dir, "state.json"), "{not json");
    expect(loadWatchdogStorage(dir).events).toEqual([]);
  });

  it("pause is a flag file the tick's saves never touch", () => {
    setWatchdogEnabled(false, dir);
    saveWatchdogStorage(loadWatchdogStorage(dir), dir);
    expect(loadWatchdogStorage(dir).enabled).toBe(false);
    setWatchdogEnabled(true, dir);
    expect(loadWatchdogStorage(dir).enabled).toBe(true);
  });

  it("shows a UI reboot marker at once and resets the stuck counters", () => {
    saveWatchdogStorage(
      {
        ...loadWatchdogStorage(dir),
        state: { ...INITIAL_WATCHDOG_STATE, stuckStreak: 2 },
      },
      dir,
    );
    recordReboot(marker(1000), dir);
    const s = loadWatchdogStorage(dir);
    expect(s.state.reboot?.at).toBe(1000);
    expect(s.state.lastRebootAt).toBe(1000);
    expect(s.state.stuckStreak).toBe(0);
  });

  it("treats a wrong-shaped state file as empty instead of spreading it", () => {
    writeFileSync(
      join(dir, "state.json"),
      '{"state":"oops","events":{"a":1},"counts":null}',
    );
    const s = loadWatchdogStorage(dir);
    expect(s.state).toEqual(INITIAL_WATCHDOG_STATE);
    expect(s.events).toEqual([]);
  });

  it("ignores an invalid marker file", () => {
    writeFileSync(join(dir, "reboot-marker.json"), '{"at":"x"}');
    expect(readPendingMarker(dir)).toBeNull();
  });

  it("consumes only the marker it applied — a newer Restart stays queued", () => {
    recordReboot(marker(1000), dir);
    consumeRebootMarker(marker(1000), dir);
    expect(existsSync(join(dir, "reboot-marker.json"))).toBe(false);
    recordReboot(marker(2000), dir);
    consumeRebootMarker(marker(1000), dir);
    expect(readPendingMarker(dir)?.at).toBe(2000);
  });
});
