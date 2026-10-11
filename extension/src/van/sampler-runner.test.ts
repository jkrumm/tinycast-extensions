import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorage, environment } from "@raycast/api";
import { rmSync } from "fs";
import { join } from "path";
import { HELPER_FULL, fixtureVictronAll } from "./fixtures";
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
vi.mock("./notify", () => ({ postNotification: vi.fn() }));

import { loadVictronHistory } from "./load";
import { runSamplerOnce } from "./sampler-runner";
import { loadSamplerState } from "./sampler-storage";

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
    await LocalStorage.clear();
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

    await LocalStorage.clear();
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
