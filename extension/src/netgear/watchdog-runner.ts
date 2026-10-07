// One watchdog tick, run from either surface: the `netgear-watchdog`
// background command (`source: "background"`) or the open Netgear view
// (`source: "view"`). Tinycast has ONE JS runtime, so no background tick runs
// while any foreground command is open — the view drives the same tick itself.
// Both go through the router action lock, the same storage and the same log;
// only the netgear.log `source` differs (`watchdog` vs `watchdog-view`).
// Imports `@raycast/api` via session/storage — glue, not unit-testable here
// (the pure policy lives in watchdog-schedule.ts and watchdog.ts).

import {
  acquireWatchdogTickLock,
  getClient,
  getPassword,
  logNetgear,
  pinStore,
  wifiCredsStore,
  wifiRejoiner,
} from "./session";
import { describeErrorDetail, describeNetgearError } from "./errors";
import { probeInternet } from "./internet-probe";
import { runWatchdogTick, breadcrumbMessage, WatchdogEvent } from "./watchdog";
import { shouldLogWatchdogEvent } from "./watchdog-schedule";
import {
  appendWatchdogEvent,
  loadWatchdogStorage,
  saveWatchdogStorage,
} from "./watchdog-storage";

export type WatchdogSource = "background" | "view";

function logSource(source: WatchdogSource): string {
  return source === "view" ? "watchdog-view" : "watchdog";
}

// The event the tick produced, or null when the watchdog is paused (nothing
// ran). A tick crash outside runWatchdogTick (which never throws) is logged,
// then rethrown so a background run's own `lastError` still shows it.
export async function runWatchdogOnce(opts: {
  source: WatchdogSource;
}): Promise<WatchdogEvent | null> {
  try {
    return await run(opts.source);
  } catch (e) {
    logNetgear({
      source: logSource(opts.source),
      action: "tick",
      outcome: "crashed",
      message: describeNetgearError(e),
      detail: describeErrorDetail(e),
    });
    throw e;
  }
}

async function run(source: WatchdogSource): Promise<WatchdogEvent | null> {
  const initial = await loadWatchdogStorage();
  if (!initial.enabled) return null;

  // Never mutate the router while a manual UI action is running — the two
  // fighting over connect/disconnect is what made "Reconnect" fail.
  const acquired = await acquireWatchdogTickLock();
  if ("heldBy" in acquired) {
    const deferred: WatchdogEvent = {
      at: Date.now(),
      kind: "deferred",
      message: "Manual action in progress — skipped",
    };
    // Re-read: the manual action holding the lock may be recording a reboot
    // marker right now, and saving the pre-lock `initial` would clobber it.
    await saveWatchdogStorage(
      appendWatchdogEvent(await loadWatchdogStorage(), deferred),
    );
    return deferred;
  }

  try {
    return await tick(source);
  } finally {
    await acquired.lock.release();
  }
}

async function tick(source: WatchdogSource): Promise<WatchdogEvent> {
  const client = await getClient();
  const password = await getPassword({ toast: false });
  // Re-read under the lock: a UI action that finished just before this tick
  // took it may have recorded a reboot marker after the first load.
  let storage = await loadWatchdogStorage();

  const { state, event } = await runWatchdogTick({
    client,
    password,
    pinStore,
    state: storage.state,
    probeInternet,
    wifi: wifiRejoiner,
    credsStore: wifiCredsStore,
    onAction: async (kind) => {
      storage = appendWatchdogEvent(storage, {
        at: Date.now(),
        kind: "in-progress",
        message: breadcrumbMessage(kind),
      });
      await saveWatchdogStorage(storage);
    },
  });

  if (shouldLogWatchdogEvent(event, storage.events)) {
    logNetgear({
      source: logSource(source),
      action: event.kind,
      outcome: /failed|error/.test(event.kind) ? "failed" : "event",
      message: event.message,
      detail: event.detail,
    });
  }
  await saveWatchdogStorage(appendWatchdogEvent({ ...storage, state }, event));
  return event;
}
