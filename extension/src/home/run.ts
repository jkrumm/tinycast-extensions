// The impure half of the Home command: spawns `home` (a zsh script that
// ssh-es to the mini, ~1-2 s per call) and keeps the last answer in
// LocalStorage so the next open renders instantly.

import { LocalStorage } from "@raycast/api";
import { execFile } from "child_process";
import { homedir } from "os";
import { PATH } from "../usage/local";
import {
  ClimatePoint,
  ClimateRange,
  parseClimate,
  rangeHours,
} from "./climate";
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
const NAMI_WRITE_KEY = "home-nami-write";
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

// Marks a Nami write across runtimes (menu bar, list and the launcher
// commands share only LocalStorage). `settledAt` is null while it is running.
export interface NamiWriteMarker {
  startedAt: number;
  settledAt: number | null;
}

export interface StatusStore {
  read(): Promise<StatusCache | null>;
  write(value: StatusCache): Promise<void>;
  readMarker(): Promise<NamiWriteMarker | null>;
  writeMarker(value: NamiWriteMarker): Promise<void>;
}

const isMarker = (v: unknown): v is NamiWriteMarker =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as NamiWriteMarker).startedAt === "number" &&
  ((v as NamiWriteMarker).settledAt === null ||
    typeof (v as NamiWriteMarker).settledAt === "number");

export const localStorageStatus: StatusStore = {
  async read() {
    const raw = await LocalStorage.getItem<string>(STATUS_KEY);
    return raw ? parseStatusCache(raw) : null;
  },
  write: (value) =>
    LocalStorage.setItem(STATUS_KEY, serializeStatusCache(value)),
  async readMarker() {
    const raw = await LocalStorage.getItem<string>(NAMI_WRITE_KEY);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isMarker(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  writeMarker: (value) =>
    LocalStorage.setItem(NAMI_WRITE_KEY, JSON.stringify(value)),
};

// A status read can predate a Nami write and must not overwrite it. Two
// guards: `pendingWrites` (this process, fast path) and the `home-nami-write`
// marker in LocalStorage (other runtimes). A read is valid only if no write
// was running or started during it: no marker, or one that started and
// settled strictly before the read began. Invalid reads are discarded: never
// written, the stored cache is returned instead. Known limit: overlapping
// writes from two different runtimes within one timeout window can let a read
// cache the pre-write state until the next refresh (display only; the switch
// itself is correct).
let pendingWrites = 0;
let writesStarted = 0;

async function readIsValid(store: StatusStore, readStart: number) {
  if (pendingWrites > 0) return false;
  const marker = await store.readMarker().catch(() => null);
  if (!marker) return true;
  // A write killed mid-flight (Tinycast ends a closed view's JS) never
  // settles; past twice the spawn timeout it counts as settled.
  const settledAt = marker.settledAt ?? marker.startedAt + 2 * TIMEOUT_MS;
  return marker.startedAt < readStart && settledAt < readStart;
}

// One ssh round trip. A sensor that is unreachable keeps its last-known
// climate numbers (with their own `climateAt`); the switches are never
// back-filled, so a null stays null. Resolves with the cache as it stands
// (null when empty) if the read was invalidated by a write.
async function fetchStatus(
  store: StatusStore,
  run: RunHome,
  readStart: number,
): Promise<StatusCache | null> {
  const [raw, cached] = await Promise.all([
    run(["status", "--json"]),
    store.read().catch(() => null),
  ]);
  if (!(await readIsValid(store, readStart)))
    return store.read().catch(() => null);
  const fresh = parseStatus(raw);
  if (!fresh) throw new Error("home status returned unreadable output");
  const { climate, lastKnown } = mergeClimate(
    fresh.climate,
    cached?.status.climate ?? null,
  );
  const next: StatusCache = {
    status: { ...fresh, climate },
    fetchedAt: readStart,
    climateAt: lastKnown && cached ? cached.climateAt : readStart,
  };
  await store.write(next).catch(() => undefined);
  return next;
}

// Single-flight: overlapping callers (mount, Refresh, menu tick) share one
// request, but only if no write has started since it began.
let inFlight: {
  writes: number;
  promise: Promise<StatusCache | null>;
} | null = null;

export function refreshStatus(
  store: StatusStore = localStorageStatus,
  run: RunHome = runHome,
  nowMs = Date.now(),
): Promise<StatusCache | null> {
  if (inFlight && inFlight.writes === writesStarted && pendingWrites === 0)
    return inFlight.promise;
  const entry = {
    writes: writesStarted,
    promise: fetchStatus(store, run, nowMs).finally(() => {
      if (inFlight === entry) inFlight = null;
    }),
  };
  inFlight = entry;
  return entry.promise;
}

export async function fetchClimate(
  run: RunHome = runHome,
  hours = 48,
): Promise<ClimatePoint[]> {
  const points = parseClimate(await run(["climate", String(hours), "--json"]));
  if (!points) throw new Error("home climate returned unreadable output");
  return points;
}

export interface ClimateData {
  range: ClimateRange; // the range these points were fetched for
  status: StatusCache | null;
  points: ClimatePoint[];
  at: number;
}

// The Climate History view's one loader: the history for the range (a failure
// rejects, so the view can say so) beside the live status (a failure keeps
// the last-known status).
export async function loadClimate(
  range: ClimateRange,
  statusStore: StatusStore = localStorageStatus,
  run: RunHome = runHome,
  nowMs = Date.now(),
): Promise<ClimateData> {
  const [points, status] = await Promise.all([
    fetchClimate(run, rangeHours(range)),
    refreshStatus(statusStore, run, nowMs).catch(() => null),
  ]);
  return {
    range,
    points,
    status: status ?? (await statusStore.read().catch(() => null)),
    at: nowMs,
  };
}

// `true` = Nami stays home, `false` = Nami comes along. On success the cache
// holds the written value immediately and is returned; on failure the cache
// is untouched and the error propagates. Either way in-flight reads are void.
export async function namiPresence(
  home: boolean,
  run: RunHome = runHome,
  store: StatusStore = localStorageStatus,
  now: () => number = Date.now,
): Promise<StatusCache> {
  const startedAt = now();
  pendingWrites += 1;
  writesStarted += 1;
  try {
    await store
      .writeMarker({ startedAt, settledAt: null })
      .catch(() => undefined);
    await run(["set", NAMI_SWITCH, "power", String(home)]);
    const cached = await store.read().catch(() => null);
    const next: StatusCache = {
      status: cached
        ? { ...cached.status, namiHome: home }
        : { climate: null, namiHome: home, someoneHome: null },
      fetchedAt: now(),
      climateAt: cached?.climateAt ?? now(),
    };
    await store.write(next).catch(() => undefined);
    return next;
  } finally {
    // Last writer wins: only settle the marker if it is still ours.
    const marker = await store.readMarker().catch(() => null);
    if (marker?.startedAt === startedAt)
      await store
        .writeMarker({ startedAt, settledAt: now() })
        .catch(() => undefined);
    pendingWrites -= 1;
  }
}

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
  const [status, scenes, climate] = await Promise.allSettled([
    refreshStatus(statusStore, run, nowMs),
    freshScenes ? Promise.resolve(freshScenes) : fetchScenes(run),
    fetchClimate(run, 24),
  ]);
  const climatePoints = climate.status === "fulfilled" ? climate.value : null;
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
      status: status.value ?? (await statusStore.read().catch(() => null)),
      scenes:
        scenes.status === "fulfilled"
          ? scenes.value
          : (cachedHome?.scenes ?? []),
      climate: climatePoints,
      error: null,
    };
  return {
    climate: climatePoints,
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
