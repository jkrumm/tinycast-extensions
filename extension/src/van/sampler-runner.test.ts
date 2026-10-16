import { beforeEach, describe, expect, it, vi } from "vitest";
import { environment } from "@raycast/api";
import { mkdirSync, statSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import {
  HELPER_BATTERY_BUSY,
  HELPER_BLUETOOTH_OFF,
  HELPER_FULL,
  fixtureVictronAll,
  helperAtSoc,
} from "./fixtures";
import { TRENDS_STALE_MS } from "./sampler";
import { VictronAllResult } from "./victron-trends";

const runMock =
  vi.fn<
    (opts?: {
      sinceMs?: number;
      history?: boolean;
    }) => Promise<VictronAllResult>
  >();
const readMock = vi.fn();
vi.mock("./run", () => ({
  readVan: (opts?: unknown) => readMock(opts),
  runVictronAll: (opts?: { sinceMs?: number; history?: boolean }) =>
    runMock(opts),
}));
const notifyMock =
  vi.fn<(opts: { title: string; body: string }) => Promise<boolean>>();
vi.mock("./notify", () => ({
  postNotification: (opts: { title: string; body: string }) => notifyMock(opts),
}));

import { loadVictronHistory } from "./load";
import { runSamplerOnce } from "./sampler-runner";
import { parseCaptureLog } from "./capture-log";
import { loadSamplerState, setSamplerPaused } from "./sampler-storage";
import { loadVanHistory } from "./storage";
import { HISTORY_FILE, SAMPLER_FILE } from "./store";
import { clearVanState, vanStatePath } from "./test-env";

const NOW = new Date(2026, 9, 9, 12, 40).getTime();

// A cache last topped up `agoMs` before NOW.
async function seedCache(agoMs: number): Promise<void> {
  runMock.mockResolvedValueOnce(fixtureVictronAll(NOW - agoMs));
  await loadVictronHistory(NOW - agoMs);
  runMock.mockClear();
}

describe("runSamplerOnce: the Victron trends top-up", () => {
  beforeEach(async () => {
    runMock.mockReset();
    readMock.mockReset();
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    clearVanState();
    rmSync(join(environment.supportPath, "van-log.jsonl"), { force: true });
  });

  it("tops the trends up when the cache is over 3 h old and the charger was heard", async () => {
    await seedCache(TRENDS_STALE_MS + 60_000);
    runMock.mockResolvedValue(fixtureVictronAll(NOW));
    await runSamplerOnce(NOW);
    expect(runMock).toHaveBeenCalledTimes(1);
    const state = await loadSamplerState();
    expect(state.lastTrendsAttemptAt).toBe(NOW);
    expect(state.lastTrends).toEqual({ at: NOW, outcome: "ok", detail: null });
  });

  it("does nothing while the cache is fresh, out of range, or before any foreground read", async () => {
    await seedCache(60 * 60_000);
    await runSamplerOnce(NOW);
    expect(runMock).not.toHaveBeenCalled();

    clearVanState();
    await runSamplerOnce(NOW); // no cache at all: pairing may still be due
    expect(runMock).not.toHaveBeenCalled();

    await seedCache(TRENDS_STALE_MS + 60_000);
    readMock.mockResolvedValue({
      helper: { battery: HELPER_FULL.battery, victron: null, errors: [] },
      keyMissing: false,
    });
    await runSamplerOnce(NOW);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("a failure is recorded and not retried for 3 h; a pairing error backs off 24 h", async () => {
    await seedCache(TRENDS_STALE_MS + 60_000);
    runMock.mockRejectedValue(new Error("victron-connect-failed"));
    await runSamplerOnce(NOW);
    expect((await loadSamplerState()).lastTrends?.outcome).toBe("failed");
    await runSamplerOnce(NOW + 15 * 60_000);
    expect(runMock).toHaveBeenCalledTimes(1);

    runMock.mockRejectedValue(new Error("victron-pairing-timeout"));
    await runSamplerOnce(NOW + 4 * 3_600_000);
    const state = await loadSamplerState();
    expect(state.lastTrends?.outcome).toBe("pairing");
    expect(state.trendsBackoffUntil).toBe(NOW + 4 * 3_600_000 + 24 * 3_600_000);
    await runSamplerOnce(NOW + 8 * 3_600_000);
    expect(runMock).toHaveBeenCalledTimes(2);
  });
});

describe("runSamplerOnce: a run against the file store", () => {
  const logPath = () => join(environment.supportPath, "van-log.jsonl");

  beforeEach(() => {
    runMock.mockReset();
    readMock.mockReset();
    notifyMock.mockReset();
    notifyMock.mockResolvedValue(true);
    clearVanState();
    rmSync(logPath(), { force: true });
  });

  it("the first run on an empty store reads unattended and writes the state, a sample and a capture line marked background", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    const subtitle = await runSamplerOnce(NOW);
    expect(readMock).toHaveBeenCalledWith({ unattended: true });
    expect(subtitle).toBe("98 % · 12:40");
    expect(existsSync(vanStatePath(SAMPLER_FILE))).toBe(true);
    expect(existsSync(vanStatePath(HISTORY_FILE))).toBe(true);
    expect(await loadVanHistory()).toHaveLength(1);
    expect((await loadSamplerState()).lastRunAt).toBe(NOW);
    const [entry] = parseCaptureLog(readFileSync(logPath(), "utf8"));
    expect(entry).toMatchObject({
      source: "background",
      ective: { soc: 98 },
      estimateReason: "background",
    });
    expect(runMock).not.toHaveBeenCalled(); // no top-up before a foreground read
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("nothing in range is an outcome: no sample, no log line, a quiet subtitle", async () => {
    readMock.mockResolvedValue({
      helper: {
        battery: null,
        victron: null,
        errors: ["battery-not-found", "victron-not-found"],
      },
      keyMissing: false,
    });
    expect(await runSamplerOnce(NOW)).toBe("Van not in range");
    expect(await loadVanHistory()).toEqual([]);
    expect(existsSync(vanStatePath(HISTORY_FILE))).toBe(false);
    expect(existsSync(logPath())).toBe(false);
  });

  it("names the phone app holding the BMS and keeps the charger's reading", async () => {
    readMock.mockResolvedValue({
      helper: HELPER_BATTERY_BUSY,
      keyMissing: false,
    });
    expect(await runSamplerOnce(NOW)).toBe("Phone app holds the battery");
    expect(await loadVanHistory()).toHaveLength(1);
  });

  it("Bluetooth off and a crashing helper are outcomes, not failures", async () => {
    readMock.mockResolvedValue({
      helper: HELPER_BLUETOOTH_OFF,
      keyMissing: false,
    });
    expect(await runSamplerOnce(NOW)).toBe("Bluetooth off");
    readMock.mockRejectedValue(new Error("van-ble exited 1"));
    expect(await runSamplerOnce(NOW)).toBe("Read failed");
    expect(await loadVanHistory()).toEqual([]);
  });

  it("an unreadable ring fails the read instead of being overwritten", async () => {
    mkdirSync(vanStatePath(HISTORY_FILE), { recursive: true });
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    expect(await runSamplerOnce(NOW)).toBe("Read failed");
    expect(statSync(vanStatePath(HISTORY_FILE)).isDirectory()).toBe(true);
  });

  it("the pause flag returns at once without a read; resuming runs again", async () => {
    await setSamplerPaused(true);
    expect(await runSamplerOnce(NOW)).toBe("Paused");
    expect(readMock).not.toHaveBeenCalled();
    expect(existsSync(vanStatePath(SAMPLER_FILE))).toBe(false);
    await setSamplerPaused(false);
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    await runSamplerOnce(NOW);
    expect(readMock).toHaveBeenCalledTimes(1);
  });

  it("posts one notification per down-crossing, none while it stays low, re-arms after a recovery", async () => {
    const run = async (soc: number) => {
      readMock.mockResolvedValue({
        helper: helperAtSoc(soc),
        keyMissing: false,
      });
      await runSamplerOnce(NOW);
    };
    await run(41);
    expect(notifyMock).not.toHaveBeenCalled();
    await run(28);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      title: "Van battery",
      body: "Van battery 28 % — stop charging devices from the van",
    });
    await run(27);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    await run(14);
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock.mock.calls[1][0].body).toContain("critically low");
    await run(40);
    await run(29);
    expect(notifyMock).toHaveBeenCalledTimes(3);
  });

  it("a notification that cannot be shown never fails the run", async () => {
    notifyMock.mockResolvedValue(false);
    readMock.mockResolvedValue({ helper: helperAtSoc(20), keyMissing: false });
    expect(await runSamplerOnce(NOW)).toMatch(/^20 % /);
  });
});
