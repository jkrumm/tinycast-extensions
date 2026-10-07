// Pure orchestration flows on top of `NetgearClient` + `SimPinStore` — no
// `@raycast/api` import, so these run under vitest with a scripted fake
// transport (see flows.test.ts) instead of the real ~minutes-long device
// polls. `sleep`/`now` are injectable on every flow for exactly that reason.
// Never call these against the real device from a test — see
// `netgear/live-actions.ts` for the one place that's allowed, gated on
// `NETGEAR_LIVE_ACTIONS=1`.

import { NetgearClient } from "./client";
import { RouterStatus } from "./types";
import { SimPinStore } from "./pin-store";
import { WifiCredentials, WifiRejoiner } from "./wifi";
import { WifiCredsStore } from "./wifi-creds-store";
import { isRouterRejection, ROUTER_UNREACHABLE_MESSAGE } from "./errors";

export type ProgressCallback = (message: string) => void;
type Sleep = (ms: number) => Promise<void>;
type Now = () => number;

// Per-flow timeout overrides — every field is optional and only ever
// shortened by the watchdog (see watchdog.ts's scaled timeouts) to fit its
// hard tick budget; interactive callers (netgear.tsx, sim-forms.tsx) never
// set this and keep the defaults below.
export interface FlowTimeouts {
  unlockMs?: number; // unlockSim() / autoUnlockIfPossible()
  disconnectMs?: number; // reconnect()
  checkMs?: number; // ensureConnected()'s "already connected?" check
  connectMs?: number; // reconnect(), ensureConnected(), toggleData()'s reconnect poll
  dataOffMs?: number; // toggleData()'s wait for Disconnected
}

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
const defaultNow: Now = () => Date.now();

const POLL_INTERVAL_MS = 2000;
// The SIM needs a while to initialise after a correct PIN.
const UNLOCK_TIMEOUT_MS = 60_000;
const DISCONNECT_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 60_000;
// Measured live (2026-10-04): ~4s off, ~4s back on.
const DATA_OFF_TIMEOUT_MS = 10_000;
const DATA_ON_TIMEOUT_MS = 15_000;
const REBOOT_DOWN_TIMEOUT_MS = 45_000;
const REBOOT_UP_TIMEOUT_MS = 4 * 60_000;
const SIM_SETTLE_TIMEOUT_MS = 30_000;
const POST_REBOOT_CONNECT_CHECK_MS = 20_000;
const POST_REBOOT_CONNECT_TIMEOUT_MS = 90_000;
// The router needs ~60s to boot; start nudging the Mac's Wi-Fi after 30s
// of unreachability, then retry every 20s.
const REJOIN_AFTER_MS = 30_000;
const REJOIN_EVERY_MS = 20_000;
// ensureRouterReachable's own, single-shot rejoin: one attempt, then poll for
// up to this long before giving up (no periodic re-rejoin like the reboot
// flow above — a router that isn't down for a reboot should reassociate
// quickly or not at all).
const REJOIN_REACHABLE_TIMEOUT_MS = 20_000;

// sim.status values the router settles on — anything else (seen briefly
// right after a reboot) is treated as transitional.
const TERMINAL_SIM_STATES = new Set([
  "Ready",
  "Locked",
  "Blocked",
  "NotPresent",
  "InvalidCard",
  "Failure",
  "Rejected",
  "MepLocked",
]);

export class SimPinRequiredError extends Error {
  constructor(public readonly status: RouterStatus) {
    super("SIM PIN required to finish reconnecting after reboot.");
    this.name = "SimPinRequiredError";
  }
}

// Never enter a stored PIN on the last remaining attempt — a wrong guess at
// retry 1 would burn the SIM to PUK-required with no chance to confirm the
// PIN first. A `fallback` PIN (the SIM's identity couldn't be confirmed) is
// only tried with every attempt left, so a swapped SIM costs at most one.
export function shouldAutoEnterPin(
  status: RouterStatus,
  storedPin: string | null,
  opts: { fallback?: boolean } = {},
): boolean {
  const minRetries = opts.fallback ? 3 : 2;
  return (
    status.simStatus === "Locked" &&
    !!storedPin &&
    status.simPinRetry >= minRetries
  );
}

export interface AutoUnlockPin {
  pin: string;
  iccid: string;
  fallback: boolean;
}

// The router reports an empty `sim.iccid` while the SIM is Locked (verified
// live 2026-09-27), so the SIM's identity comes from, in order: the status
// itself, an ICCID the caller knows is the same physical SIM (captured
// before a reboot), or — as a fallback — the last SIM seen unlocked.
export async function resolveAutoUnlockPin(opts: {
  status: RouterStatus;
  pinStore: SimPinStore;
  knownIccid?: string;
}): Promise<AutoUnlockPin | null> {
  const { status, pinStore, knownIccid } = opts;
  if (status.simStatus !== "Locked") return null;
  const confirmed = status.iccid || knownIccid || "";
  const iccid = confirmed || (await pinStore.getLastIccid()) || "";
  if (!iccid) return null;
  const fallback = !confirmed;
  const pin = await pinStore.get(iccid);
  if (!pin || !shouldAutoEnterPin(status, pin, { fallback })) return null;
  return { pin, iccid, fallback };
}

async function pollUntil(opts: {
  client: NetgearClient;
  sleep: Sleep;
  now: Now;
  timeoutMs: number;
  intervalMs?: number;
  isDone: (status: RouterStatus) => boolean;
}): Promise<RouterStatus> {
  const {
    client,
    sleep,
    now,
    timeoutMs,
    intervalMs = POLL_INTERVAL_MS,
    isDone,
  } = opts;
  const deadline = now() + timeoutMs;
  let status: RouterStatus | null = null;
  let lastError: unknown = null;
  for (;;) {
    // A transient LAN hiccup (Wi-Fi re-associating, the router's web server
    // restarting) is not a failure — only the deadline is.
    try {
      status = await client.getStatus();
      if (isDone(status)) return status;
    } catch (e) {
      lastError = e;
    }
    if (now() >= deadline) break;
    await sleep(intervalMs);
  }
  if (status) return status;
  throw lastError;
}

// Polls until `getModel()` throws (the router has gone down for its
// reboot), or gives up after `timeoutMs` and lets the caller proceed anyway
// — some firmware states never observably "go down" before coming back up.
async function pollUntilUnreachable(opts: {
  client: NetgearClient;
  sleep: Sleep;
  now: Now;
  timeoutMs: number;
  intervalMs?: number;
}): Promise<void> {
  const { client, sleep, now, timeoutMs, intervalMs = POLL_INTERVAL_MS } = opts;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      await client.getModel();
    } catch {
      return;
    }
    await sleep(intervalMs);
  }
}

// Polls until `getModel()` succeeds again — transport errors are expected
// throughout the reboot and are swallowed, not rethrown.
async function pollUntilReachable(opts: {
  client: NetgearClient;
  sleep: Sleep;
  now: Now;
  timeoutMs: number;
  intervalMs?: number;
  rejoin?: () => Promise<void>;
}): Promise<boolean> {
  const {
    client,
    sleep,
    now,
    timeoutMs,
    intervalMs = POLL_INTERVAL_MS,
    rejoin,
  } = opts;
  const start = now();
  const deadline = start + timeoutMs;
  let nextRejoinAt = start + REJOIN_AFTER_MS;
  while (now() < deadline) {
    try {
      await client.getModel();
      return true;
    } catch {
      // Expected while the router is rebooting — keep polling.
    }
    if (rejoin && now() >= nextRejoinAt) {
      await rejoin();
      nextRejoinAt = now() + REJOIN_EVERY_MS;
    }
    await sleep(intervalMs);
  }
  return false;
}

export interface UnlockSimOptions {
  client: NetgearClient;
  pin: string;
  pinStore: SimPinStore;
  remember: boolean;
  // Which SIM the PIN belongs to when the Locked status hides the ICCID.
  iccid?: string;
  // Automatic attempts pass true: any outcome other than Ready — rejected,
  // timed out, unclear — deletes the saved PIN, so a saved PIN gets at most
  // one automatic attempt ever. Manual entry forgets only on a proven
  // rejection (retry counter dropped).
  forgetOnAnyFailure?: boolean;
  onProgress?: ProgressCallback;
  sleep?: Sleep;
  now?: Now;
  timeouts?: FlowTimeouts;
}

// Enters `pin`, polls for the SIM to settle on Ready, and stores/forgets the
// PIN under the SIM's ICCID depending on the outcome — never burns a PIN
// silently: a failure always clears any previously-remembered PIN for that
// SIM, since it's now known wrong (or something else is wrong with the SIM).
export async function unlockSim(opts: UnlockSimOptions): Promise<RouterStatus> {
  const {
    client,
    pin,
    pinStore,
    remember,
    forgetOnAnyFailure = false,
    onProgress = () => {},
    sleep = defaultSleep,
    now = defaultNow,
    timeouts,
  } = opts;

  const before = await client.getStatus();
  const knownIccid = before.iccid || opts.iccid || "";
  onProgress(`Entering SIM PIN (${before.simPinRetry} retries left)…`);
  try {
    await client.enterSimPin(pin);
  } catch {
    // The router often doesn't answer the PIN request before curl's timeout
    // (the web UI's own request shows no status either) — the SIM state
    // below is the real verdict.
    onProgress("No answer to the PIN request — checking the SIM…");
  }

  let status: RouterStatus;
  try {
    status = await pollUntil({
      client,
      sleep,
      now,
      timeoutMs: timeouts?.unlockMs ?? UNLOCK_TIMEOUT_MS,
      isDone: (s) => s.simStatus === "Ready",
    });
  } catch (e) {
    // The PIN went out but the outcome is unknown — for an automatic
    // attempt that still counts as its one try.
    if (forgetOnAnyFailure && knownIccid) await pinStore.delete(knownIccid);
    throw e;
  }

  if (status.simStatus === "Ready") {
    const iccid = status.iccid || knownIccid;
    if (iccid) await pinStore.setLastIccid(iccid);
    if (remember && iccid) {
      await pinStore.set(iccid, pin);
      onProgress("PIN saved for this SIM.");
    }
    return status;
  }

  // For manual entry only a dropped retry counter proves the PIN wrong — a
  // slow SIM still Locked at the deadline keeps its saved PIN.
  const rejected = status.simPinRetry < before.simPinRetry;
  if ((rejected || forgetOnAnyFailure) && knownIccid) {
    await pinStore.delete(knownIccid);
  }
  throw new Error(
    `SIM PIN was not accepted (status: ${status.simStatus}, retries left: ${status.simPinRetry}).`,
  );
}

export interface AutoUnlockOptions {
  client: NetgearClient;
  pinStore: SimPinStore;
  status: RouterStatus;
  knownIccid?: string;
  onProgress?: ProgressCallback;
  sleep?: Sleep;
  now?: Now;
  timeouts?: FlowTimeouts;
}

// Returns the updated status once unlocked, or null when auto-unlock
// doesn't apply (not Locked, no ICCID, no stored PIN, or too few retries
// left to risk it) — never throws for the "not applicable" case, only for a
// PIN that was actually tried and rejected.
export async function autoUnlockIfPossible(
  opts: AutoUnlockOptions,
): Promise<RouterStatus | null> {
  const {
    client,
    pinStore,
    status,
    knownIccid,
    onProgress,
    sleep,
    now,
    timeouts,
  } = opts;
  const resolved = await resolveAutoUnlockPin({ status, pinStore, knownIccid });
  if (!resolved) return null;
  // Claim the PIN (read + delete) before entering it: only a Ready SIM
  // writes it back, so a concurrent attempt finds nothing to enter.
  const pin = await pinStore.take(resolved.iccid);
  if (!pin) return null;
  return unlockSim({
    client,
    pin,
    pinStore,
    remember: true,
    iccid: resolved.iccid,
    forgetOnAnyFailure: true,
    onProgress,
    sleep,
    now,
    timeouts,
  });
}

export interface ReconnectOptions {
  client: NetgearClient;
  onProgress?: ProgressCallback;
  sleep?: Sleep;
  now?: Now;
  timeouts?: FlowTimeouts;
}

// The router refuses a connect/disconnect request while it is already moving
// into (or sitting in) the requested state — typically because the watchdog
// or the web UI got there first. That refusal is only an error when the
// state afterwards says the action didn't take effect.
async function tolerateRejection(opts: {
  client: NetgearClient;
  error: unknown;
  acceptable: readonly string[];
}): Promise<void> {
  const { client, error, acceptable } = opts;
  if (!isRouterRejection(error)) throw error;
  const { connection } = await client.getStatus();
  if (!acceptable.includes(connection)) throw error;
}

async function connectTolerant(client: NetgearClient): Promise<void> {
  try {
    await client.connect();
  } catch (error) {
    await tolerateRejection({
      client,
      error,
      acceptable: ["Connecting", "Connected"],
    });
  }
}

export const NO_SERVICE_ERROR_MESSAGE =
  "No mobile network (limited service) — reconnecting can't help; try Restart & Reconnect.";

// A Ready SIM that isn't registered on any network (2026-10-07: limited service
// on a bad cell) can't get a data session however often it is asked to connect —
// polling for one only hangs the UI until the view closes. A Connected router is
// always `registered`, and a Locked SIM is a different problem, so neither trips it.
function assertRegistered(status: RouterStatus): void {
  if (status.simStatus === "Ready" && !status.registered) {
    throw new Error(NO_SERVICE_ERROR_MESSAGE);
  }
}

// Reads the state first and only does what that state needs: Connected →
// disconnect; Disconnecting → just wait; Connecting → give the connect in
// flight a chance to finish before cycling it; Disconnected → skip straight
// to connect. Then wait for Disconnected → connect → wait for Connected. More
// reliable than firing connect() straight after disconnect(): the router
// otherwise sometimes drops the connect request while still tearing down
// the previous session.
export async function reconnect(opts: ReconnectOptions): Promise<RouterStatus> {
  const {
    client,
    onProgress = () => {},
    sleep = defaultSleep,
    now = defaultNow,
    timeouts,
  } = opts;

  let status = await client.getStatus();
  assertRegistered(status);

  if (status.connection === "Connecting") {
    onProgress("Waiting for the connection in progress…");
    status = await pollUntil({
      client,
      sleep,
      now,
      timeoutMs: timeouts?.connectMs ?? CONNECT_TIMEOUT_MS,
      isDone: (s) => s.connection === "Connected",
    });
    if (status.connection === "Connected") {
      onProgress("Reconnected.");
      return status;
    }
  }

  if (status.connection === "Connected" || status.connection === "Connecting") {
    onProgress("Disconnecting…");
    try {
      await client.disconnect();
    } catch (error) {
      await tolerateRejection({
        client,
        error,
        acceptable: ["Disconnected", "Disconnecting"],
      });
    }
  }

  if (
    status.connection === "Connected" ||
    status.connection === "Connecting" ||
    status.connection === "Disconnecting"
  ) {
    status = await pollUntil({
      client,
      sleep,
      now,
      timeoutMs: timeouts?.disconnectMs ?? DISCONNECT_TIMEOUT_MS,
      isDone: (s) => s.connection === "Disconnected",
    });
    if (status.connection !== "Disconnected") {
      throw new Error(
        `Timed out waiting to disconnect (last state: ${status.connection}).`,
      );
    }
  }

  onProgress("Connecting…");
  await connectTolerant(client);
  status = await pollUntil({
    client,
    sleep,
    now,
    timeoutMs: timeouts?.connectMs ?? CONNECT_TIMEOUT_MS,
    isDone: (s) => s.connection === "Connected",
  });
  if (status.connection !== "Connected") {
    throw new Error(
      `Timed out waiting to connect (last state: ${status.connection}).`,
    );
  }

  onProgress("Reconnected.");
  return status;
}

// Soft reset: data off (`wwan.autoconnect=Never`) → wait for Disconnected →
// data on (`Always`) → wait for Connected. ~9s measured live, far gentler
// than a reboot. `Always` is restored in a `finally`, so a failed or
// timed-out off-poll can never leave data switched off (and roaming with it).
export async function toggleData(
  opts: ReconnectOptions,
): Promise<RouterStatus> {
  const {
    client,
    onProgress = () => {},
    sleep = defaultSleep,
    now = defaultNow,
    timeouts,
  } = opts;

  let off: RouterStatus;
  try {
    onProgress("Switching mobile data off…");
    await client.setDataEnabled(false);
    off = await pollUntil({
      client,
      sleep,
      now,
      timeoutMs: timeouts?.dataOffMs ?? DATA_OFF_TIMEOUT_MS,
      isDone: (s) => s.connection === "Disconnected",
    });
  } finally {
    onProgress("Switching mobile data on…");
    await client.setDataEnabled(true);
  }
  if (off.connection !== "Disconnected") {
    throw new Error(
      `Timed out waiting for data to switch off (last state: ${off.connection}).`,
    );
  }

  const status = await pollUntil({
    client,
    sleep,
    now,
    timeoutMs: timeouts?.connectMs ?? DATA_ON_TIMEOUT_MS,
    isDone: (s) => s.connection === "Connected",
  });
  if (status.connection !== "Connected") {
    throw new Error(
      `Timed out waiting to connect after the data reset (last state: ${status.connection}).`,
    );
  }
  onProgress("Reconnected.");
  return status;
}

// After a SIM unlock the router usually auto-connects on its own; give it
// a moment, then ask explicitly (unless the router has no mobile network by
// then). Unlike reconnect() it never disconnects.
export async function ensureConnected(
  opts: ReconnectOptions,
): Promise<RouterStatus> {
  const {
    client,
    onProgress = () => {},
    sleep = defaultSleep,
    now = defaultNow,
    timeouts,
  } = opts;
  let status = await pollUntil({
    client,
    sleep,
    now,
    timeoutMs: timeouts?.checkMs ?? POST_REBOOT_CONNECT_CHECK_MS,
    isDone: (s) => s.connection === "Connected",
  });
  if (status.connection === "Connected") return status;
  // After the short check above, so a SIM that was just unlocked still gets
  // that long to register before this gives up on it.
  assertRegistered(status);

  onProgress("Connecting…");
  await connectTolerant(client);
  status = await pollUntil({
    client,
    sleep,
    now,
    timeoutMs: timeouts?.connectMs ?? POST_REBOOT_CONNECT_TIMEOUT_MS,
    isDone: (s) => s.connection === "Connected",
  });
  if (status.connection !== "Connected") {
    throw new Error(
      `Timed out waiting to connect (last state: ${status.connection}).`,
    );
  }
  return status;
}

export interface RebootAndReconnectOptions {
  client: NetgearClient;
  password: string;
  pinStore: SimPinStore;
  // Rejoins the Mac to the router's Wi-Fi while it is unreachable — without
  // it the Mac may stay off the LAN and the flow can't finish.
  wifi?: WifiRejoiner;
  // Fallback source for the Wi-Fi credentials when reading them live from
  // the router (below) fails or the model doesn't carry them for some
  // reason — the credentials this Mac last saw from an earlier Admin
  // session (see wifi-creds-store.ts).
  credsStore?: WifiCredsStore;
  onProgress?: ProgressCallback;
  sleep?: Sleep;
  now?: Now;
}

// Reboot → wait for the router to drop off the LAN → wait for it to come
// back → log in again (the reboot invalidates the session) → wait for the
// SIM state to settle → auto-unlock if a PIN is saved for that SIM
// (otherwise throw SimPinRequiredError so the caller can prompt) → make
// sure the mobile connection is up. These are device polls, not agent
// turns, so the multi-minute worst case is expected, not a bug.
export async function rebootAndReconnect(
  opts: RebootAndReconnectOptions,
): Promise<RouterStatus> {
  const {
    client,
    password,
    pinStore,
    wifi,
    credsStore,
    onProgress = () => {},
    sleep = defaultSleep,
    now = defaultNow,
  } = opts;

  // Captured before the reboot — afterwards the Mac may not reach the
  // router at all, and a Locked SIM hides its ICCID.
  const preRebootIccid = (await client.getStatus()).iccid;
  let creds: WifiCredentials | null = wifi
    ? await client.getWifiCredentials().catch(() => null)
    : null;
  if (!creds && wifi && credsStore) creds = await credsStore.get();
  const rejoin =
    wifi && creds
      ? async () => {
          onProgress(`Rejoining Wi-Fi "${creds.ssid}"…`);
          await wifi.rejoin(creds).catch(() => false);
        }
      : undefined;

  onProgress("Rebooting router…");
  await client.reboot();

  onProgress("Waiting for the router to go down…");
  await pollUntilUnreachable({
    client,
    sleep,
    now,
    timeoutMs: REBOOT_DOWN_TIMEOUT_MS,
  });

  onProgress("Waiting for the router to come back…");
  const reachable = await pollUntilReachable({
    client,
    sleep,
    now,
    timeoutMs: REBOOT_UP_TIMEOUT_MS,
    rejoin,
  });
  if (!reachable) {
    throw new Error("Router did not come back within 4 minutes after reboot.");
  }

  onProgress("Logging in…");
  await client.login(password);

  onProgress("Waiting for the SIM state to settle…");
  let status = await pollUntil({
    client,
    sleep,
    now,
    timeoutMs: SIM_SETTLE_TIMEOUT_MS,
    isDone: (s) => TERMINAL_SIM_STATES.has(s.simStatus),
  });

  if (status.simStatus === "Locked") {
    onProgress("SIM is locked — attempting auto-unlock…");
    const unlocked = await autoUnlockIfPossible({
      client,
      pinStore,
      status,
      knownIccid: preRebootIccid,
      onProgress,
      sleep,
      now,
    });
    if (!unlocked) throw new SimPinRequiredError(status);
    status = unlocked;
  }

  if (status.connection !== "Connected") {
    status = await pollUntil({
      client,
      sleep,
      now,
      timeoutMs: POST_REBOOT_CONNECT_CHECK_MS,
      isDone: (s) => s.connection === "Connected",
    });
  }

  if (status.connection !== "Connected") {
    onProgress("Connecting…");
    await client.connect();
    status = await pollUntil({
      client,
      sleep,
      now,
      timeoutMs: POST_REBOOT_CONNECT_TIMEOUT_MS,
      isDone: (s) => s.connection === "Connected",
    });
  }

  onProgress("Router is back up.");
  return status;
}

export interface EnsureRouterReachableOptions {
  client: NetgearClient;
  wifi: WifiRejoiner;
  credsStore: WifiCredsStore;
  onProgress?: ProgressCallback;
  sleep?: Sleep;
  now?: Now;
}

// getModel() succeeding means the router is already reachable — nothing to
// do. Otherwise this only self-heals when the Mac has previously seen the
// router's own Wi-Fi credentials (an earlier Admin session — see
// wifi-creds-store.ts): rejoin once, then poll for reachability for up to
// 20s. With no stored creds, or a rejoin that doesn't bring the router back,
// throws the same friendly message every surface already uses (errors.ts)
// so a caller's toast/log never has to translate it itself. Used at the
// start of every admin action that's meant to work itself out of "off the
// router's Wi-Fi" (session.ts's withAdmin with `selfHeal: true`) and by the
// explicit "Rejoin Router Wi-Fi" action in netgear.tsx.
export async function ensureRouterReachable(
  opts: EnsureRouterReachableOptions,
): Promise<void> {
  const {
    client,
    wifi,
    credsStore,
    onProgress = () => {},
    sleep = defaultSleep,
    now = defaultNow,
  } = opts;

  try {
    await client.getModel();
    return;
  } catch {
    // Falls through to the rejoin attempt below.
  }

  const creds = await credsStore.get();
  if (!creds) {
    throw new Error(ROUTER_UNREACHABLE_MESSAGE);
  }

  onProgress(`Rejoining Wi-Fi "${creds.ssid}"…`);
  await wifi.rejoin(creds).catch(() => false);

  const reachable = await pollUntilReachable({
    client,
    sleep,
    now,
    timeoutMs: REJOIN_REACHABLE_TIMEOUT_MS,
  });
  if (!reachable) {
    throw new Error(ROUTER_UNREACHABLE_MESSAGE);
  }
}
