// The impure half of the Home command: spawns `home` (a zsh script that
// ssh-es to the mini, ~1-2 s per call) and keeps the last answer in
// LocalStorage so the next open renders instantly.

import { LocalStorage } from "@raycast/api";
import { execFile } from "child_process";
import { homedir } from "os";
import { PATH } from "../usage/local";
import { friendlyError, mergeClimate } from "./format";
import {
  parseCache,
  parseDoctor,
  parseScenes,
  parseStatus,
  parseStatusCache,
  serializeCache,
  serializeStatusCache,
} from "./parse";
import { Doctor, HomeCache, MenuBarData, Scene, StatusCache } from "./types";

const BIN = `${homedir()}/.local/bin/home`;
const TIMEOUT_MS = 20_000;
const CACHE_KEY = "home-cache";
const STATUS_KEY = "home-status";
const NAMI_SWITCH = "Nami zu Hause";
// The menu bar only re-fetches the scene list this often (it rarely changes).
const SCENES_MAX_AGE_MS = 6 * 60 * 60_000;

// Port: resolves with stdout on exit 0; rejects with an Error whose message
// is the CLI's stderr (or the spawn error when there is none).
export type RunHome = (args: string[]) => Promise<string>;

export const runHome: RunHome = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      BIN,
      args,
      { timeout: TIMEOUT_MS, env: { ...process.env, PATH } },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const detail = String(stderr).trim();
        const timedOut = error.killed ? "timed out" : error.message;
        reject(new Error(detail || timedOut));
      },
    );
  });

export interface HomeStore {
  read(): Promise<HomeCache | null>;
  write(value: HomeCache): Promise<void>;
}

export const localStorageHome: HomeStore = {
  async read() {
    const raw = await LocalStorage.getItem<string>(CACHE_KEY);
    return raw ? parseCache(raw) : null;
  },
  write: (value) => LocalStorage.setItem(CACHE_KEY, serializeCache(value)),
};

export async function fetchScenes(run: RunHome = runHome): Promise<Scene[]> {
  const scenes = parseScenes(await run(["scenes", "--json"]));
  if (!scenes) throw new Error("home scenes returned unreadable output");
  return scenes;
}

// Doctor is secondary: a failure is null, never an error.
export const fetchDoctor = (run: RunHome = runHome): Promise<Doctor | null> =>
  run(["doctor", "--json"]).then(parseDoctor, () => null);

// Scenes and doctor in parallel. Scenes failing rejects (the caller keeps its
// stale list); doctor failing keeps the cached doctor.
export async function refreshHome(
  store: HomeStore = localStorageHome,
  run: RunHome = runHome,
  nowMs = Date.now(),
): Promise<HomeCache> {
  const [scenes, doctor, cached] = await Promise.all([
    fetchScenes(run),
    fetchDoctor(run),
    store.read().catch(() => null),
  ]);
  const fresh = {
    scenes,
    doctor: doctor ?? cached?.doctor ?? null,
    fetchedAt: nowMs,
  };
  await store.write(fresh).catch(() => undefined);
  return fresh;
}

export const triggerScene = async (
  id: string,
  run: RunHome = runHome,
): Promise<void> => {
  await run(["trigger", id]);
};

// ─── Status (climate + Nami) ────────────────────────────────────────────────

export interface StatusStore {
  read(): Promise<StatusCache | null>;
  write(value: StatusCache): Promise<void>;
}

export const localStorageStatus: StatusStore = {
  async read() {
    const raw = await LocalStorage.getItem<string>(STATUS_KEY);
    return raw ? parseStatusCache(raw) : null;
  },
  write: (value) =>
    LocalStorage.setItem(STATUS_KEY, serializeStatusCache(value)),
};

// One ssh round trip. A sensor that is unreachable keeps its last-known
// climate numbers (with their own `climateAt`); the switches are never
// back-filled, so a null stays null.
async function fetchStatus(
  store: StatusStore,
  run: RunHome,
  nowMs: number,
): Promise<StatusCache> {
  const [raw, cached] = await Promise.all([
    run(["status", "--json"]),
    store.read().catch(() => null),
  ]);
  const fresh = parseStatus(raw);
  if (!fresh) throw new Error("home status returned unreadable output");
  const { climate, lastKnown } = mergeClimate(
    fresh.climate,
    cached?.status.climate ?? null,
  );
  const next: StatusCache = {
    status: { ...fresh, climate },
    fetchedAt: nowMs,
    climateAt: lastKnown && cached ? cached.climateAt : nowMs,
  };
  await store.write(next).catch(() => undefined);
  return next;
}

// Single-flight: overlapping callers (mount, Refresh, menu tick) share one
// request so an older response can't overwrite a newer one. A switch write
// bumps `generation`, so a read that started before it is never reused.
let generation = 0;
let inFlight: { generation: number; promise: Promise<StatusCache> } | null =
  null;

export function refreshStatus(
  store: StatusStore = localStorageStatus,
  run: RunHome = runHome,
  nowMs = Date.now(),
): Promise<StatusCache> {
  if (inFlight && inFlight.generation === generation) return inFlight.promise;
  const entry = {
    generation,
    promise: fetchStatus(store, run, nowMs).finally(() => {
      if (inFlight === entry) inFlight = null;
    }),
  };
  inFlight = entry;
  return entry.promise;
}

// `true` = Nami stays home, `false` = Nami comes along.
export const namiPresence = async (
  home: boolean,
  run: RunHome = runHome,
): Promise<void> => {
  await run(["set", NAMI_SWITCH, "power", String(home)]);
  generation += 1;
};

// The menu bar's one loader. Never rejects: a failed status keeps the
// last-known reading and reports the friendly error beside it.
export async function loadMenuBar(
  statusStore: StatusStore = localStorageStatus,
  homeStore: HomeStore = localStorageHome,
  run: RunHome = runHome,
  nowMs = Date.now(),
): Promise<MenuBarData> {
  const cachedHome = await homeStore.read().catch(() => null);
  const freshScenes =
    cachedHome && nowMs - cachedHome.fetchedAt <= SCENES_MAX_AGE_MS
      ? cachedHome.scenes
      : null;
  const [status, scenes] = await Promise.allSettled([
    refreshStatus(statusStore, run, nowMs),
    freshScenes ? Promise.resolve(freshScenes) : fetchScenes(run),
  ]);
  if (scenes.status === "fulfilled" && !freshScenes)
    await homeStore
      .write({
        scenes: scenes.value,
        doctor: cachedHome?.doctor ?? null,
        fetchedAt: nowMs,
      })
      .catch(() => undefined);
  if (status.status === "fulfilled")
    return {
      status: status.value,
      scenes:
        scenes.status === "fulfilled"
          ? scenes.value
          : (cachedHome?.scenes ?? []),
      error: null,
    };
  return {
    status: await statusStore.read().catch(() => null),
    scenes:
      scenes.status === "fulfilled" ? scenes.value : (cachedHome?.scenes ?? []),
    error: friendlyError(
      status.reason instanceof Error
        ? status.reason.message
        : String(status.reason),
    ),
  };
}
