// The watchdog's state on disk, shared by two processes that never write the
// same file: the launchd tick (scripts/netgear-watchdog.ts, bun) owns
// `state.json`; the Tinycast view owns `paused` (its existence = paused) and
// `reboot-marker.json` (a restart the UI just sent, consumed by the next tick).
// Pure fs, no `@raycast/api`, and only fs functions Tinycast's node shim
// implements (tinycast-runtime.test.ts) — so the view reads it directly and
// vitest runs it against a tmp dir.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  appendWatchdogEvent as appendToLog,
  INITIAL_WATCHDOG_STATE,
  migrateWatchdogState,
  RebootMarker,
  WatchdogEvent,
  WatchdogLog,
  WatchdogState,
} from "./watchdog";

export const DEFAULT_WATCHDOG_DIR = join(
  homedir(),
  ".local/state/netgear-watchdog",
);

const STATE_FILE = "state.json";
const PAUSED_FILE = "paused";
const MARKER_FILE = "reboot-marker.json";

export interface WatchdogStorage extends WatchdogLog {
  enabled: boolean;
  state: WatchdogState;
}

function emptyStorage(): WatchdogStorage {
  return {
    enabled: true,
    state: INITIAL_WATCHDOG_STATE,
    events: [],
    counts: {},
    since: null,
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// tmp + rename: the other process never reads a half-written file.
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function isMarker(value: unknown): value is RebootMarker {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.at === "number" &&
    (v.source === "ui" || v.source === "watchdog") &&
    typeof v.iccid === "string"
  );
}

export function readPendingMarker(dir: string): RebootMarker | null {
  const parsed = readJson(join(dir, MARKER_FILE));
  return isMarker(parsed) ? parsed : null;
}

// Folds a UI-sent reboot into the state: resets the stuck counters and anchors
// the reboot cooldown, same as the tick's own reboot does.
export function applyRebootMarker(
  state: WatchdogState,
  marker: RebootMarker,
): WatchdogState {
  return {
    ...state,
    reboot: marker,
    lastRebootAt: marker.at,
    stuckStreak: 0,
    dataToggledAt: null,
    internetFailures: 0,
    reconnectStreak: 0,
    lastReconnectAt: null,
  };
}

// The state as the next reader should see it: `state.json` + the pause flag +
// any reboot marker the tick has not consumed yet (so the view's banner shows
// a Restart immediately, not after the next minute).
export function loadWatchdogStorage(
  dir: string = DEFAULT_WATCHDOG_DIR,
): WatchdogStorage {
  const parsed = readJson(
    join(dir, STATE_FILE),
  ) as Partial<WatchdogStorage> | null;
  const base = emptyStorage();
  // A wrong-shaped file (hand edit, partial write) must not spread garbage into the state.
  const valid =
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed.state === undefined ||
      (typeof parsed.state === "object" && parsed.state !== null)) &&
    (parsed.events === undefined || Array.isArray(parsed.events)) &&
    (parsed.counts === undefined ||
      (typeof parsed.counts === "object" && parsed.counts !== null));
  const stored: WatchdogStorage =
    valid && parsed
      ? {
          ...base,
          // Merged over the defaults rather than falling back wholesale — a
          // state persisted before a field was added must still pick up that
          // field's default instead of losing the counters.
          state: migrateWatchdogState(parsed.state),
          events: parsed.events ?? [],
          counts: parsed.counts ?? {},
          since: parsed.since ?? null,
        }
      : base;
  const marker = readPendingMarker(dir);
  const state =
    marker && marker.at > (stored.state.reboot?.at ?? 0)
      ? applyRebootMarker(stored.state, marker)
      : stored.state;
  return { ...stored, state, enabled: !existsSync(join(dir, PAUSED_FILE)) };
}

// Tick-side only. `enabled` is the pause flag's, never persisted here.
export function saveWatchdogStorage(
  storage: WatchdogStorage,
  dir: string = DEFAULT_WATCHDOG_DIR,
): void {
  mkdirSync(dir, { recursive: true });
  const persisted = {
    state: storage.state,
    events: storage.events,
    counts: storage.counts,
    since: storage.since,
  };
  writeAtomic(join(dir, STATE_FILE), JSON.stringify(persisted));
}

// Drops the marker file only if it is still the one the tick applied — a
// newer Restart written meanwhile stays for the next tick. Not atomic: a
// Restart landing between the read and the rm is lost, but the router's own
// reboot is then caught by the tick's unreachable/recovery path anyway.
export function consumeRebootMarker(
  applied: RebootMarker,
  dir: string = DEFAULT_WATCHDOG_DIR,
): void {
  if (readPendingMarker(dir)?.at === applied.at) {
    rmSync(join(dir, MARKER_FILE), { force: true });
  }
}

export function setWatchdogEnabled(
  enabled: boolean,
  dir: string = DEFAULT_WATCHDOG_DIR,
): void {
  mkdirSync(dir, { recursive: true });
  if (enabled) rmSync(join(dir, PAUSED_FILE), { force: true });
  else writeAtomic(join(dir, PAUSED_FILE), String(Date.now()));
}

// View-side: hands the post-reboot recovery (rejoin Wi-Fi, unlock, connect) to
// the launchd tick, since Tinycast kills the view's JS when it closes.
export function recordReboot(
  marker: RebootMarker,
  dir: string = DEFAULT_WATCHDOG_DIR,
): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, MARKER_FILE), JSON.stringify(marker));
}

export function appendWatchdogEvent(
  storage: WatchdogStorage,
  event: WatchdogEvent,
): WatchdogStorage {
  return { ...storage, ...appendToLog(storage, event) };
}
