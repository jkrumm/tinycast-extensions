// Pure scheduling + logging policy for watchdog ticks — no `@raycast/api`
// import, so it is unit-tested directly. Tinycast has ONE JS runtime: while a
// foreground command (the Netgear view) is open, no background tick runs, so
// the open view drives the same tick itself (see watchdog-runner.ts).

import type { ActionLockHolder } from "./action-lock";
import type { WatchdogEvent } from "./watchdog";

export const VIEW_TICK_INTERVAL_MS = 60_000;
export const VIEW_TICK_FIRST_DELAY_MS = 5_000;

// Routine kinds stay out of the file log: one line a minute of "ok" would
// bury the interesting lines and rotate them out.
const UNLOGGED_KINDS: ReadonlySet<WatchdogEvent["kind"]> = new Set([
  "ok",
  "idle",
  "deferred",
  "in-progress",
]);

// `battery-empty` and `no-service` repeat every tick while the condition
// lasts — only the first of a streak is logged (in-progress breadcrumbs don't
// break a streak).
const STREAK_KINDS: ReadonlySet<WatchdogEvent["kind"]> = new Set([
  "battery-empty",
  "no-service",
]);

export function shouldLogWatchdogEvent(
  event: WatchdogEvent,
  previous: readonly WatchdogEvent[],
): boolean {
  if (UNLOGGED_KINDS.has(event.kind)) return false;
  if (!STREAK_KINDS.has(event.kind)) return true;
  return previous.find((e) => e.kind !== "in-progress")?.kind !== event.kind;
}

// A view tick is skipped while the watchdog is paused or a manual UI action
// holds the router lock (the tick would only record a "deferred" event).
export function shouldRunViewTick(opts: {
  enabled: boolean | undefined;
  lockHolder: ActionLockHolder | null;
  now?: number;
}): boolean {
  const { enabled, lockHolder, now = Date.now() } = opts;
  if (enabled === false) return false;
  return !(lockHolder?.owner === "ui" && now <= lockHolder.expiresAt);
}

export interface ViewTickerOptions {
  // Resolves false to skip this slot (paused, manual action running, …).
  shouldRun: () => Promise<boolean>;
  run: () => Promise<void>;
  intervalMs?: number;
  firstDelayMs?: number;
}

// First run after `firstDelayMs`, then every `intervalMs`; a slot is dropped
// while the previous run is still in flight, so ticks never overlap. Errors
// are the runner's to record — the ticker only keeps the loop alive.
// Returns `stop`.
export function startViewTicker(opts: ViewTickerOptions): () => void {
  const {
    shouldRun,
    run,
    intervalMs = VIEW_TICK_INTERVAL_MS,
    firstDelayMs = VIEW_TICK_FIRST_DELAY_MS,
  } = opts;
  let inFlight = false;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  async function slot(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      if (await shouldRun()) await run();
    } catch {
      // recorded by the runner (netgear.log); the next slot retries
    } finally {
      inFlight = false;
    }
  }

  const first = setTimeout(() => {
    void slot();
    if (!stopped) interval = setInterval(() => void slot(), intervalMs);
  }, firstDelayMs);

  return () => {
    stopped = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
