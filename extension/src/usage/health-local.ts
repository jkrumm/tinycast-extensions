// The impure half of the Sessions health reading: ask `claude-account health
// --json` (slow — it ssh-es to the peer machine), cache the answer across the
// menu bar's short-lived runs, and start the re-login a row offers.

import { LocalStorage } from "@raycast/api";
import { spawn } from "child_process";
import { homedir } from "os";
import { PATH, RunClaudeAccount, claudeAccountRunner } from "./local";
import {
  StampedHealth,
  isHealthFresh,
  parseHealth,
  parseStampedHealth,
  parseFixCommand,
} from "./health";

// ssh to the peer takes up to ~10 s; the rest is headroom for a slow link.
const HEALTH_TIMEOUT_MS = 30_000;
const CACHE_KEY = "claude-health";
const RELOGIN_BIN = `${homedir()}/.local/bin/claude-relogin`;

// `health` exits 1 when a row fails and still prints the JSON — the shared
// runner resolves on any stdout.
const runHealth = claudeAccountRunner(HEALTH_TIMEOUT_MS);

export interface HealthStore {
  read(): Promise<StampedHealth | null>;
  write(value: StampedHealth): Promise<void>;
}

export const localStorageHealth: HealthStore = {
  async read() {
    const raw = await LocalStorage.getItem<string>(CACHE_KEY);
    return raw ? parseStampedHealth(raw) : null;
  },
  write: (value) => LocalStorage.setItem(CACHE_KEY, JSON.stringify(value)),
};

// A cached reading younger than 5 minutes is returned as is. Otherwise ask
// again; when that fails the last reading is kept (null only if there never
// was one), so a flaky ssh does not blank the section.
export async function loadHealth(
  store: HealthStore = localStorageHealth,
  run: RunClaudeAccount = runHealth,
  nowMs = Date.now(),
): Promise<StampedHealth | null> {
  const cached = await store.read().catch(() => null);
  if (isHealthFresh(cached, nowMs)) return cached;
  const report = await run(["health", "--json"]).then(parseHealth, () => null);
  if (!report) return cached;
  const fresh = { report, fetchedAt: nowMs };
  await store.write(fresh).catch(() => undefined);
  return fresh;
}

export type SpawnRelogin = (bin: string, args: string[]) => void;

const spawnDetached: SpawnRelogin = (bin, args) => {
  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PATH },
  });
  child.unref?.();
};

// Starts the re-login a health row's `fix` names — false (nothing spawned)
// unless it is exactly `claude-relogin <id> [--machine mini|macbook]`. The
// browser approval happens outside this process, so it is not awaited.
export function launchRelogin(
  fix: string | null,
  spawnFn: SpawnRelogin = spawnDetached,
): boolean {
  const args = parseFixCommand(fix);
  if (!args) return false;
  spawnFn(RELOGIN_BIN, args);
  return true;
}
