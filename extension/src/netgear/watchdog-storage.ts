// LocalStorage persistence for the `netgear-watchdog` no-view command —
// shared between the command entry (`netgear-watchdog.tsx`, which writes
// after every tick) and `netgear.tsx` (which reads it to show a status row
// and lets the user pause/resume or open the log). Imports `@raycast/api`
// (`LocalStorage`), so — like `session.ts` — this is glue, not pure logic;
// the ring-buffer/JSON shape is simple enough not to need its own test.

import { LocalStorage } from "@raycast/api";
import {
  appendWatchdogEvent as appendToLog,
  INITIAL_WATCHDOG_STATE,
  migrateWatchdogState,
  RebootMarker,
  WatchdogEvent,
  WatchdogLog,
  WatchdogState,
} from "./watchdog";

export const WATCHDOG_STORAGE_KEY = "netgear-watchdog";

export interface WatchdogStorage extends WatchdogLog {
  enabled: boolean;
  state: WatchdogState;
}

const DEFAULT_STORAGE: WatchdogStorage = {
  enabled: true,
  state: INITIAL_WATCHDOG_STATE,
  events: [],
  counts: {},
  since: null,
};

export async function loadWatchdogStorage(): Promise<WatchdogStorage> {
  const raw = await LocalStorage.getItem<string>(WATCHDOG_STORAGE_KEY);
  if (!raw) return DEFAULT_STORAGE;
  try {
    const parsed = JSON.parse(raw) as Partial<WatchdogStorage>;
    return {
      enabled: parsed.enabled ?? true,
      // Merged over the defaults rather than falling back to them wholesale —
      // a state object persisted before a new field (e.g. lastRejoinAttemptAt,
      // reconnectStreak, lastBattery) was added must still pick up that
      // field's default instead of losing internetFailures/lastReconnectAt too.
      state: migrateWatchdogState(parsed.state),
      events: parsed.events ?? [],
      counts: parsed.counts ?? {},
      since: parsed.since ?? null,
    };
  } catch {
    return DEFAULT_STORAGE;
  }
}

export async function saveWatchdogStorage(
  storage: WatchdogStorage,
): Promise<void> {
  await LocalStorage.setItem(WATCHDOG_STORAGE_KEY, JSON.stringify(storage));
}

// Persists the marker for a router restart the UI just sent, so the watchdog
// recovers from it (rejoin Wi-Fi, unlock, connect) instead of the open view
// having to poll for minutes — Tinycast kills the view's JS when it closes.
// Also resets the stuck counters and anchors the reboot cooldown. Called while
// holding the router action lock, so no watchdog tick can write concurrently.
export async function recordReboot(marker: RebootMarker): Promise<void> {
  const storage = await loadWatchdogStorage();
  await saveWatchdogStorage({
    ...storage,
    state: {
      ...storage.state,
      reboot: marker,
      lastRebootAt: marker.at,
      stuckStreak: 0,
      dataToggledAt: null,
      internetFailures: 0,
      reconnectStreak: 0,
      lastReconnectAt: null,
    },
  });
}

export function appendWatchdogEvent(
  storage: WatchdogStorage,
  event: WatchdogEvent,
): WatchdogStorage {
  return { ...storage, ...appendToLog(storage, event) };
}
