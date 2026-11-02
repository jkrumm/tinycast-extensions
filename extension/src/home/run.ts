// The impure half of the Home command: spawns `home` (a zsh script that
// ssh-es to the mini, ~1-2 s per call) and keeps the last answer in
// LocalStorage so the next open renders instantly.

import { LocalStorage } from "@raycast/api";
import { execFile } from "child_process";
import { homedir } from "os";
import { PATH } from "../usage/local";
import { parseCache, parseDoctor, parseScenes, serializeCache } from "./parse";
import { Doctor, HomeCache, Scene } from "./types";

const BIN = `${homedir()}/.local/bin/home`;
const TIMEOUT_MS = 20_000;
const CACHE_KEY = "home-cache";

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
