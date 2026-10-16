// Pure logging policy for watchdog ticks — no `@raycast/api` import, so it is
// unit-tested directly.

import type { WatchdogEvent } from "./watchdog";

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
