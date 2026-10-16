import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { environment } from "@raycast/api";
import { fixtureSamples, fixtureVictronAll } from "./fixtures";
import { INITIAL_SAMPLER_STATE } from "./sampler";
import {
  loadSamplerState,
  saveSamplerState,
  setSamplerPaused,
} from "./sampler-storage";
import {
  HISTORY_FILE,
  PAUSED_FILE,
  SAMPLER_FILE,
  VICTRON_HISTORY_FILE,
  hasStoreFile,
  readStoreJson,
  vanDir,
  writeStoreJson,
} from "./store";
import {
  loadVanHistory,
  loadVictronHistoryCache,
  saveVanHistory,
  saveVictronHistoryCache,
} from "./storage";
import { clearVanState, vanStatePath } from "./test-env";

const corrupt = (name: string, content = "{not json") => {
  mkdirSync(vanDir(), { recursive: true });
  writeFileSync(vanStatePath(name), content);
};

describe("van file store", () => {
  beforeEach(clearVanState);

  it("writes atomically: the directory is created, the content whole, no tmp file left", () => {
    writeStoreJson("x.json", { a: 1 });
    expect(JSON.parse(readFileSync(vanStatePath("x.json"), "utf8"))).toEqual({
      a: 1,
    });
    expect(readdirSync(vanDir())).toEqual(["x.json"]);
    writeStoreJson("x.json", { a: 2 });
    expect(readStoreJson("x.json")).toEqual({ a: 2 });
    expect(readdirSync(vanDir())).toEqual(["x.json"]);
  });

  it("a missing file reads as null", () => {
    expect(readStoreJson("nope.json")).toBeNull();
  });

  it("a file that does not parse is moved aside, logged, and reads as null", () => {
    corrupt("bad.json");
    expect(readStoreJson("bad.json")).toBeNull();
    const files = readdirSync(vanDir());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^bad\.json\.corrupt-\d+$/);
    expect(readFileSync(join(vanDir(), files[0]), "utf8")).toBe("{not json");
    expect(
      readFileSync(join(environment.supportPath, "van-store.log"), "utf8"),
    ).toContain("bad.json did not parse");
  });

  it("any other IO error throws and leaves the file alone, so a read-modify-write never overwrites what it could not read", async () => {
    mkdirSync(vanStatePath(HISTORY_FILE), { recursive: true }); // EISDIR on read
    expect(() => readStoreJson(HISTORY_FILE)).toThrow();
    await expect(loadVanHistory()).rejects.toThrow();
    await expect(loadSamplerState()).resolves.toBeDefined(); // a different file
    expect(readdirSync(vanDir())).toEqual([HISTORY_FILE]);
  });

  it("the history ring round-trips; a corrupt or wrong-shaped file is empty, bad entries dropped", async () => {
    expect(await loadVanHistory()).toEqual([]);
    const samples = fixtureSamples(Date.now(), 4);
    await saveVanHistory(samples);
    expect(await loadVanHistory()).toEqual(samples);
    corrupt(HISTORY_FILE);
    expect(await loadVanHistory()).toEqual([]);
    corrupt(HISTORY_FILE, '{"t":1}');
    expect(await loadVanHistory()).toEqual([]);
    writeStoreJson(HISTORY_FILE, [samples[0], { t: "x" }, null]);
    expect(await loadVanHistory()).toEqual([samples[0]]);
  });

  it("the Victron cache round-trips; a corrupt or wrong-shaped file is no cache", async () => {
    expect(await loadVictronHistoryCache()).toBeNull();
    const cache = {
      attemptedAt: 1,
      ok: true,
      updatedAt: 1,
      historyAt: 1,
      history: fixtureVictronAll(1).history,
      trends: null,
    };
    await saveVictronHistoryCache(cache);
    expect(await loadVictronHistoryCache()).toEqual(cache);
    corrupt(VICTRON_HISTORY_FILE);
    expect(await loadVictronHistoryCache()).toBeNull();
    writeStoreJson(VICTRON_HISTORY_FILE, { attemptedAt: 1, ok: "yes" });
    expect(await loadVictronHistoryCache()).toBeNull();
  });
});

describe("sampler state file and pause flag", () => {
  beforeEach(clearVanState);

  it("an empty store is the initial state; a corrupt file too", async () => {
    expect(await loadSamplerState()).toEqual(INITIAL_SAMPLER_STATE);
    corrupt(SAMPLER_FILE);
    expect(await loadSamplerState()).toEqual(INITIAL_SAMPLER_STATE);
    expect(readdirSync(vanDir())).toEqual([
      expect.stringMatching(/^sampler\.json\.corrupt-/),
    ]);
  });

  it("the daemon's state never carries `paused`; the flag file is the only source", async () => {
    await saveSamplerState({ ...INITIAL_SAMPLER_STATE, lastRunAt: 5 });
    expect(readStoreJson(SAMPLER_FILE)).not.toHaveProperty("paused");
    expect((await loadSamplerState()).lastRunAt).toBe(5);

    // a stale `paused: true` in the file (older build) does not pause
    writeStoreJson(SAMPLER_FILE, { lastRunAt: 6, paused: true });
    expect((await loadSamplerState()).paused).toBe(false);

    const paused = await setSamplerPaused(true);
    expect(paused).toMatchObject({ paused: true, lastRunAt: 6 });
    expect(hasStoreFile(PAUSED_FILE)).toBe(true);
    // the daemon saving mid-pause keeps the pause
    await saveSamplerState({ ...paused, lastRunAt: 7 });
    expect((await loadSamplerState()).paused).toBe(true);
    expect((await setSamplerPaused(false)).paused).toBe(false);
    expect(hasStoreFile(PAUSED_FILE)).toBe(false);
    expect((await setSamplerPaused(false)).paused).toBe(false);
  });
});
