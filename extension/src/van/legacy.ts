// One-shot move of the Van Power state out of Tinycast's LocalStorage into the
// file store (store.ts), run by the view on open. Imports `@raycast/api`, so —
// like nothing else the launchd sampler loads — it is view-side only.
//
// A store file that already exists wins (the sampler may have written it
// first), except the 72 h ring, where the legacy samples are merged in so the
// sampler's first run does not cost the history. The old key is removed once
// its data is safely on disk; a failed move leaves it for the next open.

import { LocalStorage } from "@raycast/api";
import { HISTORY_WINDOW_MS } from "./history";
import { migrateSamplerState } from "./sampler";
import { saveSamplerState, setSamplerPaused } from "./sampler-storage";
import {
  loadVanHistory,
  parseVanHistory,
  parseVictronHistoryCache,
  saveVanHistory,
  saveVictronHistoryCache,
} from "./storage";
import {
  PAUSED_FILE,
  SAMPLER_FILE,
  VICTRON_HISTORY_FILE,
  hasStoreFile,
} from "./store";

export const LEGACY_HISTORY_KEY = "van-history";
export const LEGACY_VICTRON_KEY = "van-victron-history";
export const LEGACY_SAMPLER_KEY = "van-sampler";

async function legacyValue(key: string): Promise<unknown> {
  const raw = await LocalStorage.getItem<string>(key);
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function moveKey(
  key: string,
  seed: (value: unknown) => Promise<void> | void,
): Promise<void> {
  try {
    const value = await legacyValue(key);
    if (value === undefined) return;
    await seed(value);
    await LocalStorage.removeItem(key);
  } catch {
    // Kept for the next open; the view must not break on a migration.
  }
}

export async function migrateLegacyVanStorage(): Promise<void> {
  await moveKey(LEGACY_HISTORY_KEY, async (value) => {
    const legacy = parseVanHistory(value);
    if (legacy.length === 0) return;
    const byTime = new Map(
      [...legacy, ...(await loadVanHistory())].map((s) => [s.t, s]),
    );
    const merged = [...byTime.values()].sort((a, b) => a.t - b.t);
    const newest = merged[merged.length - 1].t;
    await saveVanHistory(
      merged.filter((s) => s.t >= newest - HISTORY_WINDOW_MS),
    );
  });
  await moveKey(LEGACY_VICTRON_KEY, async (value) => {
    const cache = parseVictronHistoryCache(value);
    if (cache && !hasStoreFile(VICTRON_HISTORY_FILE)) {
      await saveVictronHistoryCache(cache);
    }
  });
  await moveKey(LEGACY_SAMPLER_KEY, async (value) => {
    if (hasStoreFile(SAMPLER_FILE)) return;
    const state = migrateSamplerState(value);
    await saveSamplerState(state);
    if (state.paused && !hasStoreFile(PAUSED_FILE))
      await setSamplerPaused(true);
  });
}
