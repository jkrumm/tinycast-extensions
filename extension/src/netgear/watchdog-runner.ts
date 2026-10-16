// One watchdog tick, run by the launchd entry point (scripts/netgear-watchdog.ts,
// wrapped in `jobrun`). No `@raycast/api`: everything process-specific (paths,
// the client, the password, the log) is injected, so the whole run is
// unit-tested against a fake router and a tmp dir.

import type { NetgearClient } from "./client";
import { withDeadline } from "./deadline";
import { describeErrorDetail, describeNetgearError } from "./errors";
import { probeInternet } from "./internet-probe";
import { pinStore, wifiCredsStore, wifiRejoiner } from "./adapters";
import type { SimPinStore } from "./pin-store";
import type { WifiRejoiner } from "./wifi";
import type { WifiCredsStore } from "./wifi-creds-store";
import { runWatchdogTick, breadcrumbMessage, WatchdogEvent } from "./watchdog";
import { shouldLogWatchdogEvent } from "./watchdog-schedule";
import {
  appendWatchdogEvent,
  consumeRebootMarker,
  loadWatchdogStorage,
  readPendingMarker,
  saveWatchdogStorage,
} from "./watchdog-storage";
import type { LogEntry } from "../lib/action-log";

// The password comes from Keychain only: `op read` blocks on a biometric
// prompt nobody can answer unattended. Past this a tick carries on as if none
// were configured instead of hanging until jobrun's deadline.
const PASSWORD_DEADLINE_MS = 5_000;

export interface WatchdogRunDeps {
  dir: string;
  getClient: () => Promise<NetgearClient>;
  getPassword: () => Promise<string | null>;
  log: (entry: LogEntry) => void;
  // Production defaults; tests inject fakes so nothing touches Keychain or curl.
  pinStore?: SimPinStore;
  credsStore?: WifiCredsStore;
  wifi?: WifiRejoiner;
  probeInternet?: () => Promise<boolean>;
}

// The event the tick produced, or null when the watchdog is paused (nothing
// ran). A crash outside runWatchdogTick (which never throws) is logged, then
// rethrown so jobrun records the run red.
export async function runWatchdogOnce(
  deps: WatchdogRunDeps,
): Promise<WatchdogEvent | null> {
  try {
    return await tick(deps);
  } catch (e) {
    deps.log({
      source: "watchdog",
      action: "tick",
      outcome: "crashed",
      message: describeNetgearError(e),
      detail: describeErrorDetail(e),
    });
    throw e;
  }
}

async function tick(deps: WatchdogRunDeps): Promise<WatchdogEvent | null> {
  const { dir } = deps;
  if (!loadWatchdogStorage(dir).enabled) return null;

  const client = await deps.getClient();
  const password = await withDeadline(
    deps.getPassword(),
    PASSWORD_DEADLINE_MS,
    () => null,
  );
  // Read the marker first, then the state: loadWatchdogStorage folds it in, and
  // consumption below only drops the file this exact marker came from.
  const marker = readPendingMarker(dir);
  let storage = loadWatchdogStorage(dir);

  const { state, event } = await runWatchdogTick({
    client,
    password,
    pinStore: deps.pinStore ?? pinStore,
    state: storage.state,
    probeInternet: deps.probeInternet ?? probeInternet,
    wifi: deps.wifi ?? wifiRejoiner,
    credsStore: deps.credsStore ?? wifiCredsStore,
    onAction: (kind) => {
      storage = appendWatchdogEvent(storage, {
        at: Date.now(),
        kind: "in-progress",
        message: breadcrumbMessage(kind),
      });
      saveWatchdogStorage(storage, dir);
    },
  });

  if (shouldLogWatchdogEvent(event, storage.events)) {
    deps.log({
      source: "watchdog",
      action: event.kind,
      outcome: /failed|error/.test(event.kind) ? "failed" : "event",
      message: event.message,
      detail: event.detail,
    });
  }
  saveWatchdogStorage(appendWatchdogEvent({ ...storage, state }, event), dir);
  if (marker) consumeRebootMarker(marker, dir);
  return event;
}
