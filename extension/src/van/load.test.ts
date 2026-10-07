import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorage, environment } from "@raycast/api";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { parseVictronReadLog, summariseVictronReads } from "./capture-log";
import { VictronAllResult, VictronTrends } from "./victron-trends";
import { fixtureVictronAll } from "./fixtures";
import { VICTRON_HISTORY_TTL_MS, compactTrends } from "./history";

const runMock =
  vi.fn<
    (opts?: {
      sinceMs?: number;
      history?: boolean;
    }) => Promise<VictronAllResult>
  >();
vi.mock("./run", () => ({
  readVan: vi.fn(),
  runVictronAll: (opts?: { sinceMs?: number; history?: boolean }) =>
    runMock(opts),
}));

import { loadVictronCache, loadVictronHistory } from "./load";

const NOW = new Date(2026, 9, 5, 12, 0).getTime();
const MIN = 60_000;

const lastT = (trends: VictronTrends | null, vreg: number) =>
  trends!.trends.find((t) => t.vreg === vreg)!.samples.at(-1)!.t;
const count = (trends: VictronTrends | null, vreg: number) =>
  trends!.trends.find((t) => t.vreg === vreg)!.samples.length;

// What a later, incremental read returns: only the samples newer than `since`,
// at the device's 5-minute step, anchored 40 minutes after the first read.
function incremental(base: VictronAllResult, later: number): VictronAllResult {
  const full = fixtureVictronAll(later);
  const since = base.trends!.trends[0].samples.at(-1)!.t;
  return {
    ...full,
    history: { total: null, days: [], errors: [] },
    trends: {
      anchor: { ...full.trends!.anchor, unixMs: later },
      trends: full.trends!.trends.map((trend) => ({
        ...trend,
        samples: trend.samples.filter((s) => s.t > since),
      })),
    },
  };
}

describe("loadVictronHistory", () => {
  beforeEach(async () => {
    runMock.mockReset();
    await LocalStorage.clear();
    rmSync(join(environment.supportPath, "van-log.jsonl"), { force: true });
  });

  const reads = () =>
    summariseVictronReads(
      parseVictronReadLog(
        readFileSync(join(environment.supportPath, "van-log.jsonl"), "utf8"),
      ),
    );

  it("first open: reads everything, caches it compactly under one key", async () => {
    const all = fixtureVictronAll(NOW);
    runMock.mockResolvedValue(all);
    const first = await loadVictronHistory(NOW);
    expect(runMock).toHaveBeenCalledWith({ sinceMs: undefined, history: true });
    expect(first.error).toBeNull();
    expect(first.history).toEqual(all.history);
    expect(first.trends!.trends.map((t) => t.vreg).sort()).toEqual([
      0xec8a, 0xed8d, 0xed8f,
    ]);
    expect(first.updatedAt).toBe(NOW);
    const raw = await LocalStorage.getItem<string>("van-victron-history");
    expect(raw!.length).toBeLessThan(110_000);
  });

  it("paints from the cache at once, without any BLE", async () => {
    expect(await loadVictronCache()).toMatchObject({
      history: null,
      trends: null,
      updatedAt: null,
    });
    runMock.mockResolvedValue(fixtureVictronAll(NOW));
    const loaded = await loadVictronHistory(NOW);
    runMock.mockClear();
    expect(await loadVictronCache()).toEqual(loaded);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("every later open reads only what is new and merges it; the daily history is skipped within the hour", async () => {
    const all = fixtureVictronAll(NOW);
    runMock.mockResolvedValueOnce(all);
    const first = await loadVictronHistory(NOW);
    const before = count(first.trends, 0xec8a);

    const later = NOW + 40 * MIN;
    runMock.mockResolvedValueOnce(incremental(all, later));
    const second = await loadVictronHistory(later);
    expect(runMock).toHaveBeenLastCalledWith({
      sinceMs: Math.min(
        lastT(first.trends, 0xec8a),
        lastT(first.trends, 0xed8d),
      ),
      history: false,
    });
    expect(count(second.trends, 0xec8a)).toBeGreaterThan(before - 20);
    expect(lastT(second.trends, 0xec8a)).toBeGreaterThan(
      lastT(first.trends, 0xec8a),
    );
    expect(second.history).toEqual(first.history); // kept, not re-read
    expect(second.updatedAt).toBe(later);
  });

  it("re-reads the daily history after an hour and on a new local day", async () => {
    const all = fixtureVictronAll(NOW);
    runMock.mockResolvedValue(all);
    await loadVictronHistory(NOW);
    await loadVictronHistory(NOW + VICTRON_HISTORY_TTL_MS);
    expect(runMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ history: true }),
    );
    const nextMorning = new Date(2026, 9, 6, 7, 0).getTime();
    await loadVictronHistory(nextMorning);
    expect(runMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ history: true }),
    );
  });

  it("uses a partial result: history without trends, and trends without history", async () => {
    const all = fixtureVictronAll(NOW);
    runMock.mockResolvedValueOnce({
      ...all,
      trends: null,
      errors: ["victron-trends-unsupported"],
    });
    const noTrends = await loadVictronHistory(NOW);
    expect(noTrends.history).toEqual(all.history);
    expect(noTrends.trends).toBeNull();
    expect(noTrends.error).toBeNull();

    await LocalStorage.clear();
    runMock.mockResolvedValueOnce({
      ...all,
      history: { total: null, days: [], errors: ["victron-total-unreadable"] },
    });
    const noHistory = await loadVictronHistory(NOW);
    expect(noHistory.history).toBeNull();
    expect(noHistory.trends).not.toBeNull();
    expect(noHistory.error).toBeNull();
  });

  it("never throws: a failed read keeps the cache, says so quietly, and the next open tries again", async () => {
    const all = fixtureVictronAll(NOW);
    runMock.mockResolvedValueOnce(all);
    const first = await loadVictronHistory(NOW);

    runMock.mockRejectedValueOnce(new Error("van-ble hung for 200000 ms"));
    const failed = await loadVictronHistory(NOW + 5 * MIN);
    expect(failed.history).toEqual(first.history);
    expect(failed.trends).toEqual(first.trends);
    expect(failed.updatedAt).toBe(NOW); // not bumped by a failure
    expect(failed.error).toContain("Victron history unavailable");
    expect(failed.error).toContain("hung");

    runMock.mockResolvedValueOnce(incremental(all, NOW + 10 * MIN));
    const retried = await loadVictronHistory(NOW + 10 * MIN);
    expect(retried.error).toBeNull();
    expect(runMock).toHaveBeenCalledTimes(3);
  });

  it("nothing from either part is a failure with the helper's reason", async () => {
    runMock.mockResolvedValue({
      history: { total: null, days: [], errors: [] },
      trends: null,
      errors: ["victron-pairing-timeout"],
    });
    const result = await loadVictronHistory(NOW);
    expect(result.history).toBeNull();
    expect(result.trends).toBeNull();
    expect(result.error).toContain("victron-pairing-timeout");
  });

  it("a cache without battery current cannot be topped up: read the whole window again", async () => {
    const all = fixtureVictronAll(NOW);
    runMock.mockResolvedValueOnce(all);
    await loadVictronHistory(NOW);
    const raw = JSON.parse(
      (await LocalStorage.getItem<string>("van-victron-history"))!,
    );
    raw.trends.trends = raw.trends.trends.filter(
      (t: { vreg: number }) => t.vreg !== 0xed8f,
    );
    await LocalStorage.setItem("van-victron-history", JSON.stringify(raw));
    runMock.mockResolvedValueOnce(all);
    await loadVictronHistory(NOW + 5 * MIN);
    expect(runMock).toHaveBeenLastCalledWith({
      sinceMs: undefined,
      history: false,
    });
  });

  it("logs every attempt: start, then done with what it added, or failed with why", async () => {
    const all = fixtureVictronAll(NOW);
    runMock.mockResolvedValueOnce(all);
    await loadVictronHistory(NOW);
    runMock.mockRejectedValueOnce(new Error("victron-connect-failed"));
    await loadVictronHistory(NOW + 5 * MIN);
    const rows = reads();
    expect(rows.map((r) => r.outcome)).toEqual(["done", "failed"]);
    expect(rows[0]).toMatchObject({
      history: true,
      sinceMs: null,
      historyDays: 30,
    });
    expect(rows[0].newSamples!).toBeGreaterThan(200);
    expect(rows[1]).toMatchObject({
      detail: "victron-connect-failed",
      history: false,
    });
    expect(rows[1].sinceMs).not.toBeNull();
  });

  it("a read that adds nothing (the charger asleep) is not a failure — and says so", async () => {
    const all = fixtureVictronAll(NOW);
    runMock.mockResolvedValueOnce(all);
    const first = await loadVictronHistory(NOW);
    runMock.mockResolvedValueOnce({
      history: { total: null, days: [], errors: [] },
      trends: null,
      errors: [],
    });
    const second = await loadVictronHistory(NOW + 30 * MIN);
    expect(second.error).toBeNull();
    expect(second.trends!.trends.map((t) => t.vreg)).toEqual(
      first.trends!.trends.map((t) => t.vreg),
    );
    expect(second.trends!.trends[0].samples.length).toBeGreaterThan(
      first.trends!.trends[0].samples.length - 10,
    );
    const rows = reads();
    expect(rows.at(-1)).toMatchObject({
      outcome: "done",
      newSamples: 0,
      detail: "nothing newer on the device",
    });
  });

  it("ignores a legacy or corrupt cache entry and reads everything", async () => {
    await LocalStorage.setItem(
      "van-victron-history",
      JSON.stringify({
        attemptedAt: NOW - 60_000,
        ok: true,
        history: null,
        solarW: null,
      }),
    );
    runMock.mockResolvedValue(fixtureVictronAll(NOW));
    await loadVictronHistory(NOW);
    expect(runMock).toHaveBeenLastCalledWith({
      sinceMs: undefined,
      history: true,
    });

    await LocalStorage.setItem("van-victron-history", "{not json");
    await loadVictronHistory(NOW + 1);
    expect(runMock).toHaveBeenLastCalledWith({
      sinceMs: undefined,
      history: true,
    });
    expect(compactTrends(null)).toBeNull();
  });
});
