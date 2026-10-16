// File-backed Van Power history (store.ts): the 72 h sample ring and the
// Victron cache, shared by the view and the launchd sampler. Pure fs, no
// `@raycast/api`; the ring behaviour lives in history.ts.

import { VictronHistoryCache } from "./history";
import {
  HISTORY_FILE,
  VICTRON_HISTORY_FILE,
  readStoreJson,
  writeStoreJson,
} from "./store";
import { Sample } from "./types";

function isSample(value: unknown): value is Sample {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as Sample).t)
  );
}

export function parseVanHistory(value: unknown): Sample[] {
  return Array.isArray(value) ? value.filter(isSample) : [];
}

export async function loadVanHistory(): Promise<Sample[]> {
  return parseVanHistory(readStoreJson(HISTORY_FILE));
}

export async function saveVanHistory(history: Sample[]): Promise<void> {
  writeStoreJson(HISTORY_FILE, history);
}

function isHistoryCache(value: unknown): value is VictronHistoryCache {
  if (typeof value !== "object" || value === null) return false;
  const cache = value as VictronHistoryCache;
  return (
    Number.isFinite(cache.attemptedAt) &&
    typeof cache.ok === "boolean" &&
    (cache.history === null ||
      (typeof cache.history === "object" &&
        Array.isArray(cache.history.days))) &&
    (cache.trends === null ||
      (typeof cache.trends === "object" && Array.isArray(cache.trends.trends)))
  );
}

export function parseVictronHistoryCache(
  value: unknown,
): VictronHistoryCache | null {
  return isHistoryCache(value) ? value : null;
}

export async function loadVictronHistoryCache(): Promise<VictronHistoryCache | null> {
  return parseVictronHistoryCache(readStoreJson(VICTRON_HISTORY_FILE));
}

export async function saveVictronHistoryCache(
  cache: VictronHistoryCache,
): Promise<void> {
  writeStoreJson(VICTRON_HISTORY_FILE, cache);
}
