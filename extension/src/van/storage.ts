// LocalStorage glue for the Van Power history — imports `@raycast/api`, so
// (like netgear/watchdog-storage.ts) this is glue, not pure logic; the ring
// behaviour lives in history.ts.

import { LocalStorage } from "@raycast/api";
import { VictronHistoryCache } from "./history";
import { Sample } from "./types";

export const VAN_HISTORY_KEY = "van-history";
export const VICTRON_HISTORY_KEY = "van-victron-history";

function isSample(value: unknown): value is Sample {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as Sample).t)
  );
}

export async function loadVanHistory(): Promise<Sample[]> {
  const raw = await LocalStorage.getItem<string>(VAN_HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSample) : [];
  } catch {
    return [];
  }
}

export async function saveVanHistory(history: Sample[]): Promise<void> {
  await LocalStorage.setItem(VAN_HISTORY_KEY, JSON.stringify(history));
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

export async function loadVictronHistoryCache(): Promise<VictronHistoryCache | null> {
  const raw = await LocalStorage.getItem<string>(VICTRON_HISTORY_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHistoryCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveVictronHistoryCache(
  cache: VictronHistoryCache,
): Promise<void> {
  await LocalStorage.setItem(VICTRON_HISTORY_KEY, JSON.stringify(cache));
}
