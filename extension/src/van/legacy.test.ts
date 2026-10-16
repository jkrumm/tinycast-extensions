import { beforeEach, describe, expect, it } from "vitest";
import { LocalStorage, environment } from "@raycast/api";
import { mkdirSync, readFileSync } from "fs";
import { fixtureSamples, fixtureVictronAll } from "./fixtures";
import {
  LEGACY_HISTORY_KEY,
  LEGACY_SAMPLER_KEY,
  LEGACY_VICTRON_KEY,
  migrateLegacyVanStorage,
} from "./legacy";
import { INITIAL_SAMPLER_STATE } from "./sampler";
import { loadSamplerState, saveSamplerState } from "./sampler-storage";
import {
  loadVanHistory,
  loadVictronHistoryCache,
  saveVanHistory,
  saveVictronHistoryCache,
} from "./storage";
import { HISTORY_FILE, PAUSED_FILE, hasStoreFile } from "./store";
import { clearVanState, vanStatePath } from "./test-env";
import { join } from "path";

const NOW = new Date(2026, 9, 9, 12, 40).getTime();
const cache = (updatedAt: number) => ({
  attemptedAt: updatedAt,
  ok: true,
  updatedAt,
  historyAt: updatedAt,
  history: fixtureVictronAll(updatedAt).history,
  trends: null,
});
const put = (key: string, value: unknown) =>
  LocalStorage.setItem(key, JSON.stringify(value));

describe("migrateLegacyVanStorage", () => {
  beforeEach(async () => {
    clearVanState();
    await LocalStorage.clear();
  });

  it("seeds absent files from the old keys and removes the keys", async () => {
    const samples = fixtureSamples(NOW, 5);
    await put(LEGACY_HISTORY_KEY, samples);
    await put(LEGACY_VICTRON_KEY, cache(NOW));
    await put(LEGACY_SAMPLER_KEY, { ...INITIAL_SAMPLER_STATE, lastRunAt: 9 });
    await migrateLegacyVanStorage();
    expect(await loadVanHistory()).toEqual(samples);
    expect(await loadVictronHistoryCache()).toEqual(cache(NOW));
    expect((await loadSamplerState()).lastRunAt).toBe(9);
    expect(await LocalStorage.allItems()).toEqual({});
  });

  it("a paused sampler stays paused (the flag file is seeded)", async () => {
    await put(LEGACY_SAMPLER_KEY, { ...INITIAL_SAMPLER_STATE, paused: true });
    await migrateLegacyVanStorage();
    expect(hasStoreFile(PAUSED_FILE)).toBe(true);
    expect((await loadSamplerState()).paused).toBe(true);
  });

  it("a legacy pause survives an existing sampler.json (the daemon ran first)", async () => {
    await saveSamplerState({ ...INITIAL_SAMPLER_STATE, lastRunAt: 1 });
    await put(LEGACY_SAMPLER_KEY, { ...INITIAL_SAMPLER_STATE, paused: true });
    await migrateLegacyVanStorage();
    expect(hasStoreFile(PAUSED_FILE)).toBe(true);
    expect((await loadSamplerState()).lastRunAt).toBe(1);
    expect(await LocalStorage.allItems()).toEqual({});
  });

  it("a failed move keeps the key for the next open and leaves a line in the store log", async () => {
    mkdirSync(vanStatePath(HISTORY_FILE), { recursive: true }); // unreadable ring
    await put(LEGACY_HISTORY_KEY, fixtureSamples(NOW, 3));
    await migrateLegacyVanStorage();
    expect(Object.keys(await LocalStorage.allItems())).toEqual([
      LEGACY_HISTORY_KEY,
    ]);
    expect(
      readFileSync(join(environment.supportPath, "van-store.log"), "utf8"),
    ).toMatch(new RegExp(`migrate\\s+failed\\s+${LEGACY_HISTORY_KEY}:`));
  });

  it("existing files win; the old ring is merged under the sampler's newer samples", async () => {
    const old = fixtureSamples(NOW - 3_600_000, 4);
    const fresh = fixtureSamples(NOW, 1);
    await saveVanHistory(fresh);
    await saveVictronHistoryCache(cache(NOW));
    await saveSamplerState({ ...INITIAL_SAMPLER_STATE, lastRunAt: 1 });
    await put(LEGACY_HISTORY_KEY, old);
    await put(LEGACY_VICTRON_KEY, cache(NOW - 1000));
    await put(LEGACY_SAMPLER_KEY, { ...INITIAL_SAMPLER_STATE, lastRunAt: 2 });
    await migrateLegacyVanStorage();
    expect(await loadVanHistory()).toEqual([...old, ...fresh]);
    expect((await loadVictronHistoryCache())?.updatedAt).toBe(NOW);
    expect((await loadSamplerState()).lastRunAt).toBe(1);
    expect(await LocalStorage.allItems()).toEqual({});
  });

  it("does nothing without old keys, and a second run is a no-op", async () => {
    await migrateLegacyVanStorage();
    expect(hasStoreFile(HISTORY_FILE)).toBe(false);
    await put(LEGACY_HISTORY_KEY, fixtureSamples(NOW, 3));
    await migrateLegacyVanStorage();
    await migrateLegacyVanStorage();
    expect(await loadVanHistory()).toHaveLength(3);
  });

  it("an unparsable old key is dropped without breaking the rest", async () => {
    await LocalStorage.setItem(LEGACY_HISTORY_KEY, "{not json");
    await put(LEGACY_VICTRON_KEY, cache(NOW));
    await migrateLegacyVanStorage();
    expect(await loadVanHistory()).toEqual([]);
    expect(await loadVictronHistoryCache()).toEqual(cache(NOW));
    expect(await LocalStorage.allItems()).toEqual({});
  });
});
