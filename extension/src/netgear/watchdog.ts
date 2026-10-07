// Pure orchestration for the `netgear-watchdog` no-view background command —
// no `@raycast/api` import, so this runs under vitest with the same fake
// transport / FakePinStore / fakeClock patterns as flows.test.ts (see
// test-helpers.ts) instead of a real device or a real `curl` probe.
//
// Deliberately narrow: it unlocks a SIM with an already-saved PIN, connects,
// reconnects, and — as of the Wi-Fi rejoin rule below — rejoins the router's
// own Wi-Fi, but *only* when the Mac has no internet at all (see
// `runWatchdogTick`'s unreachable branch); it never touches the Mac's Wi-Fi
// while a normal home network with real internet is active. It also keeps data
// roaming switched on (`wwan.autoconnect === "Always"`), one write per tick.
//
// Escalation ladder for a stuck router, split by what the router reports:
// - Not Connected (connect-failed): connect first; no data toggle — it failed
//   2/2 live on 2026-10-05 against a router stuck Disconnected (connect
//   accepted, nothing happens, inactivityCause 307) and only a reboot cleared
//   it — so the reboot comes on the 2nd consecutive failed connect
//   (STUCK_DISCONNECTED_REBOOT_THRESHOLD).
// - Connected but the internet probe fails: confirm in the same tick (re-probe
//   after CONFIRM_DELAY_MS — see below), reconnect first, then — on
//   the second stuck tick, once per stuck episode — a data off/on soft reset
//   (`toggleData`, ~9s; it replaces that tick's reconnect and counts as stuck
//   until the router proves healthy), and only then the reboot (3rd stuck tick,
//   STUCK_REBOOT_THRESHOLD; also for reconnect-failed).
//
// It reboots the router only as a last resort: after those thresholds of
// consecutive failed ticks, at most once per REBOOT_COOLDOWN_MS, and never
// while the SIM is Locked/Blocked (a reboot can't fix that and could re-lock
// it). The reboot is fire-and-forget — the POST returns at once and a reboot
// marker (`state.reboot`) is persisted; the following ticks recover from it
// (rejoin Wi-Fi immediately, auto-unlock with the marker's ICCID, connect) and
// clear the marker. The UI's "Restart & Reconnect" writes the same marker.
//
// Battery awareness (2026-10-06: the router's battery died overnight and the
// watchdog "rejoined" a Wi-Fi that was not there eight times): every tick that
// read a status records the router's battery; a low battery is announced once
// per crossing (`battery-low`, notice only), and an unreachable router whose
// last reading was a near-empty battery on no charger is reported as
// `battery-empty` instead of being chased with Wi-Fi rejoins. A rejoin only
// counts as `rejoined` if the router answers afterwards.
//
// No mobile network (2026-10-06: the router sat on `LimitedService` for an hour
// — cells seen, never allowed to register — and the watchdog kept connecting
// and escalated to a pointless reboot): a reachable router with a Ready SIM
// that is not `registered` is never connected or data-toggled. The tick reports
// `no-service` and resets the stuck ladder; a restart is the only action, and
// it escalates (see noServiceRebootDue): the first after
// NO_SERVICE_FIRST_REBOOT_AFTER_MS of continuous no-service, then after 30 min,
// 2 h and every 6 h (`noServiceRebootCount`, reset once it registers again).
// Live: 2026-10-07 the router camped on a bad cell (B3, RSRP -115, SINR -7)
// for 35 min where coverage normally exists and a restart fixed it within a
// minute (vodafone P, B1, RSRP -88); 2026-10-06 restarts did not help because
// there was genuinely no coverage — so try early, then back off. The first tick
// back on a network reports `service-restored` and then carries on normally.
//
// Tinycast kills a background run after ~60s (see docs/netgear-m2.md §
// Watchdog), so every flow call a tick can take runs with the shortened
// timeouts below instead of the interactive (netgear.tsx) defaults.

import { NetgearClient } from "./client";
import { RouterStatus } from "./types";
import { SimPinStore } from "./pin-store";
import {
  autoUnlockIfPossible,
  ensureConnected,
  reconnect,
  toggleData,
  FlowTimeouts,
} from "./flows";
import { WifiRejoiner } from "./wifi";
import { WifiCredsStore, captureWifiCredentials } from "./wifi-creds-store";
import { describeNetgearError, ROUTER_UNREACHABLE_MESSAGE } from "./errors";

export type WatchdogEventKind =
  | "idle"
  | "no-service"
  | "service-restored"
  | "no-password"
  | "needs-pin"
  | "sim-problem"
  | "unlocked"
  | "roaming-enabled"
  | "connected"
  | "connect-failed"
  | "ok"
  | "probe-failed"
  | "reconnected"
  | "reconnect-failed"
  | "data-toggled"
  | "data-toggle-failed"
  | "rebooted"
  | "rebooting"
  | "recovered"
  | "rejoined"
  | "rejoin-failed"
  | "battery-low"
  | "battery-empty"
  | "power-restored"
  | "in-progress"
  | "deferred"
  | "error";

// A long action the tick is about to attempt — used only to build the
// `in-progress` breadcrumb event `onAction` persists before it starts (see
// `RunWatchdogTickOptions.onAction`), so a kill mid-flight still leaves a
// trace instead of silence.
export type WatchdogActionKind =
  | "unlocking"
  | "connecting"
  | "reconnecting"
  | "rejoining"
  | "toggling-data"
  | "rebooting";

export function breadcrumbMessage(kind: WatchdogActionKind): string {
  switch (kind) {
    case "unlocking":
      return "In progress: unlocking SIM…";
    case "connecting":
      return "In progress: connecting…";
    case "reconnecting":
      return "In progress: reconnecting…";
    case "rejoining":
      return "In progress: rejoining Wi-Fi…";
    case "toggling-data":
      return "In progress: switching mobile data off/on…";
    case "rebooting":
      return "In progress: restarting the router…";
  }
}

export interface WatchdogEvent {
  at: number; // epoch ms — the latest occurrence
  kind: WatchdogEventKind;
  message: string;
  // The raw error text when `message` is its friendly translation — shown
  // under the message in the Watchdog Log and written to the Netgear log.
  detail?: string;
  // Set when identical consecutive routine ticks were collapsed into one.
  firstAt?: number;
  count?: number;
  // The router's battery level while it is low (<= BATTERY_LOW_LEVEL) and not
  // charging, from the status the tick read — only `formatSubtitle` uses it.
  batteryLow?: number;
}

export const WATCHDOG_LOG_LIMIT = 60;
const COLLAPSIBLE: ReadonlySet<WatchdogEventKind> = new Set([
  "ok",
  "idle",
  "deferred",
  "battery-empty",
  "no-service",
]);

export interface WatchdogLog {
  events: WatchdogEvent[]; // newest first
  counts: Partial<Record<WatchdogEventKind, number>>;
  since: number | null; // epoch ms of the first counted tick
}

// Newest-first log: consecutive identical routine ticks (ok/idle with the
// same message) collapse into one entry, so the 60 entries span hours of
// quiet running while every noteworthy event keeps its own row. `counts`
// accumulate per kind for long-run stats.
export function appendWatchdogEvent(
  log: WatchdogLog,
  event: WatchdogEvent,
): WatchdogLog {
  const counts = {
    ...log.counts,
    [event.kind]: (log.counts[event.kind] ?? 0) + 1,
  };
  const since = log.since ?? event.at;
  const [head, ...rest] = log.events;
  if (
    head &&
    COLLAPSIBLE.has(event.kind) &&
    head.kind === event.kind &&
    head.message === event.message
  ) {
    const merged: WatchdogEvent = {
      ...head,
      at: event.at,
      firstAt: head.firstAt ?? head.at,
      count: (head.count ?? 1) + 1,
      batteryLow: event.batteryLow,
    };
    return { events: [merged, ...rest], counts, since };
  }
  return {
    events: [event, ...log.events].slice(0, WATCHDOG_LOG_LIMIT),
    counts,
    since,
  };
}

// A router restart this extension triggered (the UI's Restart & Reconnect or
// the watchdog's last-resort reboot). While it is younger than
// REBOOT_RECOVERY_WINDOW_MS the router being unreachable is expected, not an
// outage, and the watchdog recovers from it instead of idling.
export interface RebootMarker {
  at: number; // epoch ms
  source: "ui" | "watchdog";
  // Captured before the reboot — a Locked SIM hides its ICCID, and the saved
  // PIN is keyed by it.
  iccid: string;
}

export const REBOOT_RECOVERY_WINDOW_MS = 5 * 60_000;

// How long a marker is kept for the view's "did not come back" warning once
// the recovery window has passed (the watchdog stops recovering at
// REBOOT_RECOVERY_WINDOW_MS but drops the marker only after this, or as soon
// as the router is Connected + online again).
export const REBOOT_MARKER_TTL_MS = 30 * 60_000;

const UPTIME_SLACK_MS = 60_000;

// True once the router's own uptime is shorter than the time since the reboot
// was sent (plus slack) — i.e. it really restarted. An unreadable uptime
// counts as restarted.
export function rebootCompleted(
  uptimeSeconds: number | null,
  rebootAt: number,
  now: number,
): boolean {
  return (
    uptimeSeconds === null ||
    uptimeSeconds * 1000 <= now - rebootAt + UPTIME_SLACK_MS
  );
}

export function activeRebootMarker(
  marker: RebootMarker | null,
  now: number,
): RebootMarker | null {
  return marker && now - marker.at < REBOOT_RECOVERY_WINDOW_MS ? marker : null;
}

// The router's battery as of the last tick that read a status.
export interface BatteryReading {
  level: number; // percent
  charging: boolean;
  at: number; // epoch ms
}

export interface WatchdogState {
  // Consecutive failed `probeInternet()` calls while Connected — reset to 0
  // on any success, unlock, or fresh connect.
  internetFailures: number;
  // Backoff guard: after a reconnect, the next one waits
  // `reconnectBackoffMs(reconnectStreak)`.
  lastReconnectAt: number | null;
  // Consecutive reconnects without an intervening successful probe — drives
  // the escalating backoff and resets to 0 the moment the internet is back.
  reconnectStreak: number;
  // Backoff guard for the Wi-Fi rejoin rule below — never attempt more than
  // once per REJOIN_BACKOFF_MS, same reasoning as lastReconnectAt.
  lastRejoinAttemptAt: number | null;
  // Backoff guard for the data-roaming rule: one write per tick at most, and
  // not again for ROAMING_BACKOFF_MS — so a router that ignores or rejects
  // the write is never hammered once a minute.
  lastRoamingAttemptAt: number | null;
  // Consecutive ticks that ended in a failure a reboot might fix — see
  // nextStuckStreak. Reaching STUCK_REBOOT_THRESHOLD triggers the reboot.
  stuckStreak: number;
  // When the data off/on soft reset last ran in the current stuck episode, or
  // null — at most one per episode, cleared whenever stuckStreak resets.
  dataToggledAt: number | null;
  // When a reboot was last sent, by anyone (a failed attempt counts too, so a
  // router that refuses it isn't hammered) — the cooldown anchor.
  lastRebootAt: number | null;
  // The reboot being recovered from, or null.
  reboot: RebootMarker | null;
  // Battery as of the last tick that read a status — what tells an unreachable
  // router that ran empty from one that is merely off the Wi-Fi.
  lastBattery: BatteryReading | null;
  // The lowest BATTERY_NOTICE_LEVELS step already announced in the current
  // low-battery crossing, or null when armed (see nextLowBatteryNotice).
  lowBatteryNoticeLevel: number | null;
  // When `battery-empty` was first reported, until the router is back —
  // what makes `power-restored` fire exactly once.
  batteryEmptyAt: number | null;
  // When the router first reported no mobile network (limited service), until
  // it registers again — drives the escalating no-service reboots and
  // `service-restored`. Kept across a no-service reboot, so it measures the
  // whole outage.
  noServiceSince: number | null;
  // When the no-service reboot last ran (a failed attempt counts too).
  lastNoServiceRebootAt: number | null;
  // No-service reboots in the current outage (a failed attempt counts too) —
  // picks the gap to the next one, reset when the router registers again.
  noServiceRebootCount: number;
}

export const INITIAL_WATCHDOG_STATE: WatchdogState = {
  internetFailures: 0,
  lastReconnectAt: null,
  reconnectStreak: 0,
  lastRejoinAttemptAt: null,
  lastRoamingAttemptAt: null,
  stuckStreak: 0,
  dataToggledAt: null,
  lastRebootAt: null,
  reboot: null,
  lastBattery: null,
  lowBatteryNoticeLevel: null,
  batteryEmptyAt: null,
  noServiceSince: null,
  lastNoServiceRebootAt: null,
  noServiceRebootCount: 0,
};

// State persisted by an older version lacks newer fields — fill them from the
// defaults instead of losing the whole object.
export function migrateWatchdogState(
  persisted: Partial<WatchdogState> | undefined,
): WatchdogState {
  return { ...INITIAL_WATCHDOG_STATE, ...persisted };
}

// Battery thresholds. A low battery is announced at each NOTICE level once
// per crossing and re-armed above BATTERY_REARM_LEVEL (hysteresis) or when it
// starts charging. "Empty" is the level at/below which an unreachable router
// is assumed to have run out, if the reading is younger than the max age.
export const BATTERY_LOW_LEVEL = 20;
const BATTERY_NOTICE_LEVELS = [20, 10] as const;
const BATTERY_REARM_LEVEL = 25;
export const BATTERY_EMPTY_LEVEL = 10;
export const BATTERY_EMPTY_MAX_AGE_MS = 12 * 60 * 60_000;
// While the battery is presumed empty the router may have been plugged in
// meanwhile: try the Wi-Fi at most this often.
export const BATTERY_EMPTY_REJOIN_BACKOFF_MS = 30 * 60_000;

// How long after a Wi-Fi rejoin the router must answer for it to count, and
// how often it is polled meanwhile.
export const REJOIN_REACHABLE_WAIT_MS = 10_000;
const REJOIN_POLL_MS = 2_000;

// Two consecutive failed internet probes before reconnecting — one bad probe
// is noise, not a real outage.
const INTERNET_FAILURE_THRESHOLD = 2;

// In-tick confirmation: the first failed probe of an outage is re-checked
// CONFIRM_DELAY_MS later inside the same tick instead of waiting a whole tick
// (~75s live, 2026-10-05) for the second one. Both failing counts as the 2nd
// consecutive failure at once; the re-probe succeeding is a transient blip
// (plain `ok`). PROBE_TIMEOUT_MS mirrors internet-probe.ts's curl `-m 8`.
export const CONFIRM_DELAY_MS = 10_000;
export const PROBE_TIMEOUT_MS = 8_000;
export const CONFIRM_COST_MS = CONFIRM_DELAY_MS + PROBE_TIMEOUT_MS;
// The confirm is skipped (cross-tick counting as before) unless the budget,
// minus its worst case, still leaves at least this much for the long action.
const MIN_ACTION_BUDGET_MS = 25_000;

// Escalating wait after a reconnect that didn't bring the internet back: a
// quick second try (2 min) since most outages are a stuck session, then
// progressively gentler (5, then 10 min from the 3rd on) so a real carrier
// outage isn't hammered.
export function reconnectBackoffMs(streak: number): number {
  if (streak <= 0) return 0;
  if (streak === 1) return 2 * 60_000;
  if (streak === 2) return 5 * 60_000;
  return 10 * 60_000;
}
// The Wi-Fi rejoin rule (see runWatchdogTick) only ever fires when the Mac
// has zero internet at all, which is already rare — no need to retry more
// often than this.
const REJOIN_BACKOFF_MS = 5 * 60_000;
// After a reboot the outage is expected and self-inflicted, so the Wi-Fi is
// rejoined immediately — just not more often than this.
const POST_REBOOT_REJOIN_BACKOFF_MS = 30_000;
// Failed ticks in a row before the last-resort reboot, and the minimum gap
// between two reboots.
export const STUCK_REBOOT_THRESHOLD = 3;
// A router stuck Disconnected skips the data toggle (see runTick) and
// reboots on its 2nd consecutive failed connect.
export const STUCK_DISCONNECTED_REBOOT_THRESHOLD = 2;
// The data off/on soft reset is the tick that brings the streak to
// STUCK_REBOOT_THRESHOLD - 1, so the next stuck tick reboots.
const DATA_TOGGLE_STREAK = STUCK_REBOOT_THRESHOLD - 1;

function reconnectBackoffElapsed(state: WatchdogState, t: number): boolean {
  return (
    state.lastReconnectAt === null ||
    t - state.lastReconnectAt >= reconnectBackoffMs(state.reconnectStreak)
  );
}

function shouldToggleData(state: WatchdogState): boolean {
  return (
    state.stuckStreak === DATA_TOGGLE_STREAK - 1 && state.dataToggledAt === null
  );
}
export const REBOOT_COOLDOWN_MS = 30 * 60_000;
// Continuous no-service time before the first reboot is allowed, and the gaps
// before each following one (indexed by `noServiceRebootCount - 1`, the last
// entry repeats). The 30-min second gap equals REBOOT_COOLDOWN_MS, which is
// compared with `>=` against the same anchor (a no-service reboot sets both
// lastNoServiceRebootAt and lastRebootAt), so the general cooldown never delays
// it; it does hold back the first one if any other reboot ran <30 min ago.
export const NO_SERVICE_FIRST_REBOOT_AFTER_MS = 5 * 60_000;
export const NO_SERVICE_REBOOT_GAPS_MS = [
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;
const NO_SERVICE_MESSAGE =
  "No mobile network — limited service (operator not available here). Waiting for coverage.";
const ROAMING_BACKOFF_MS = 10 * 60_000;

type Sleep = (ms: number) => Promise<void>;
type Now = () => number;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
const defaultNow: Now = () => Date.now();

// Tinycast kills a background run after `min(max(interval, 15), 120)`s = 60s
// for this command's 1-minute interval (ExtensionRefreshPolicy.swift:64,
// verified live via `consecutiveFailures`/`lastError: "Timed out."` in
// extension-commands.json — see docs/netgear-m2.md § Watchdog). A tick only
// ever takes ONE of the four long actions below (unlock+connect, connect,
// reconnect, or the data off/on toggle) — never more than one per tick — so budgetMs is the ceiling
// for whichever single one runs, scaled down from the interactive
// (netgear.tsx) flow defaults; a getStatus/login call ahead of it is fast
// once the router is known reachable.
export const DEFAULT_WATCHDOG_BUDGET_MS = 45_000;

// Exported only for watchdog.test.ts's budget-arithmetic assertions.
export function scaledTimeouts(budgetMs: number): FlowTimeouts {
  const scale = budgetMs / DEFAULT_WATCHDOG_BUDGET_MS;
  return {
    unlockMs: Math.round(20_000 * scale),
    checkMs: Math.round(5_000 * scale),
    connectMs: Math.round(15_000 * scale),
    disconnectMs: Math.round(12_000 * scale),
    dataOffMs: Math.round(10_000 * scale),
  };
}

function makeEvent(
  at: number,
  kind: WatchdogEventKind,
  message: string,
): WatchdogEvent {
  return { at, kind, message };
}

function makeErrorEvent(
  at: number,
  kind: WatchdogEventKind,
  e: unknown,
): WatchdogEvent {
  const message = describeNetgearError(e);
  const raw = e instanceof Error ? e.message : String(e);
  // The Mac lost the router's Wi-Fi mid-action (live 2026-10-07 18:12): a
  // LAN problem, not a stuck mobile connection — report it like any other
  // unreachable tick so it never feeds the stuck ladder (data toggle,
  // reboot) aimed at a router this Mac can't even reach.
  if (
    message === ROUTER_UNREACHABLE_MESSAGE &&
    (kind === "connect-failed" ||
      kind === "reconnect-failed" ||
      kind === "data-toggle-failed")
  ) {
    return { at, kind: "idle", message: "Router not reachable", detail: raw };
  }
  return raw === message
    ? { at, kind, message }
    : { at, kind, message, detail: raw };
}

export interface RunWatchdogTickOptions {
  client: NetgearClient;
  // null when no admin password is configured/resolvable — a normal state,
  // not an error.
  password: string | null;
  pinStore: SimPinStore;
  state: WatchdogState;
  // Injected so tests never shell out to the real `curl` — production wires
  // this to a captive-portal HTTP check (see netgear/internet-probe.ts).
  probeInternet: () => Promise<boolean>;
  // Forwarded into every flows.ts call, same seam flows.test.ts already
  // uses (fakeClock) — without it a scripted failure path would poll on
  // real setTimeout/Date.now() and a test would take as long as the real
  // device timeout (up to 90s).
  now?: Now;
  sleep?: Sleep;
  // Both required for the Wi-Fi rejoin rule (router unreachable + zero
  // internet at all + creds known) — omit either to keep the watchdog's
  // original "never touch Wi-Fi" behaviour (e.g. no stored creds yet).
  wifi?: WifiRejoiner;
  credsStore?: WifiCredsStore;
  // Called (and awaited) right before the tick starts a long action —
  // unlocking, connecting, reconnecting, or rejoining Wi-Fi — so the caller
  // can persist a breadcrumb first. If Tinycast kills the process mid-flight
  // (see DEFAULT_WATCHDOG_BUDGET_MS above), the next log read still shows
  // what was in progress instead of silence.
  onAction?: (kind: WatchdogActionKind) => void | Promise<void>;
  // Ceiling for whichever single long action this tick takes — see
  // DEFAULT_WATCHDOG_BUDGET_MS.
  budgetMs?: number;
}

export interface WatchdogTickResult {
  state: WatchdogState;
  event: WatchdogEvent;
}

// What the wrapper needs from the pass that ran: the newest router status the
// tick saw (after login), to judge whether a reboot is allowed.
interface TickSeen {
  status?: RouterStatus;
}

// A tick ending in one of these is "stuck" in the reboot-escalation sense.
// A data toggle is itself a stuck tick (the escalation step, not a proof of
// health). Only `ok`, `connected` and `recovered` prove the router works again;
// `reconnected` doesn't (the probe hasn't run since), so it leaves the streak
// alone. A failed probe only counts once reconnects have already failed to help.
function nextStuckStreak(
  streak: number,
  state: WatchdogState,
  kind: WatchdogEventKind,
): number {
  switch (kind) {
    case "connect-failed":
    case "reconnect-failed":
    case "data-toggled":
    case "data-toggle-failed":
      return streak + 1;
    case "probe-failed":
      return state.reconnectStreak >= 2 ? streak + 1 : streak;
    case "ok":
    case "connected":
    case "recovered":
    case "no-service":
      return 0;
    default:
      return streak;
  }
}

const STUCK_REASON: Partial<Record<WatchdogEventKind, string>> = {
  "connect-failed": "could not connect",
  "reconnect-failed": "reconnects failed",
  "probe-failed": "no internet after reconnects",
};

// One watchdog pass plus the last-resort escalation: the pass itself
// (`runTick`) never reboots; this counts consecutive stuck ticks and, once the
// threshold, cooldown and SIM guards allow, sends the reboot and writes the
// marker the following ticks recover from. Always resolves to a
// `{ state, event }` pair — never throws.
export async function runWatchdogTick(
  opts: RunWatchdogTickOptions,
): Promise<WatchdogTickResult> {
  const seen: TickSeen = {};
  const state = migrateWatchdogState(opts.state);
  const result = await runEscalatingTick({ ...opts, state }, seen);
  return applyBatteryAwareness(
    applyServiceAwareness(result, seen.status, state.noServiceSince),
    seen.status,
  );
}

async function runEscalatingTick(
  opts: RunWatchdogTickOptions,
  seen: TickSeen,
): Promise<WatchdogTickResult> {
  const { client, wifi, credsStore, onAction } = opts;
  const result = await runTick(opts, seen);
  const t = result.event.at;

  const stuckStreak = nextStuckStreak(
    result.state.stuckStreak,
    result.state,
    result.event.kind,
  );
  const state = {
    ...result.state,
    stuckStreak,
    dataToggledAt: stuckStreak === 0 ? null : result.state.dataToggledAt,
  };
  const cooledDown =
    state.lastRebootAt === null || t - state.lastRebootAt >= REBOOT_COOLDOWN_MS;
  const status = seen.status;
  const noServiceReboot =
    result.event.kind === "no-service" && noServiceRebootDue(state, t);
  const rebootAllowed =
    (noServiceReboot ||
      stuckStreak >=
        (result.event.kind === "connect-failed"
          ? STUCK_DISCONNECTED_REBOOT_THRESHOLD
          : STUCK_REBOOT_THRESHOLD)) &&
    cooledDown &&
    !activeRebootMarker(state.reboot, t) &&
    status?.simStatus === "Ready";

  // The stuck state's diagnostic: what the router itself says about the
  // data session, read fresh because the connect attempt just changed it.
  const diagnostics =
    result.event.kind === "connect-failed" ||
    result.event.kind === "data-toggled" ||
    result.event.kind === "data-toggle-failed" ||
    rebootAllowed
      ? await wwanDiagnostics(client, status)
      : null;
  const withContext =
    status && INCIDENT_KINDS.has(result.event.kind)
      ? appendDetail(result.event, incidentContext(status))
      : result.event;
  const event = diagnostics
    ? appendDetail(withContext, diagnostics)
    : withContext;
  if (!rebootAllowed || !status) return { state, event };

  // The Mac may lose the router's Wi-Fi in the reboot — make sure its
  // credentials are known before it goes down.
  if (wifi && credsStore)
    await captureWifiCredentials({ client, store: credsStore });
  const reason = noServiceReboot
    ? `no service for ${Math.round((t - (state.noServiceSince ?? t)) / 60_000)} min`
    : (STUCK_REASON[result.event.kind] ?? "stuck");
  const noServiceRebootAt = noServiceReboot
    ? {
        lastNoServiceRebootAt: t,
        noServiceRebootCount: state.noServiceRebootCount + 1,
      }
    : {};
  await onAction?.("rebooting");
  try {
    await client.reboot();
  } catch (e) {
    return {
      state: { ...state, lastRebootAt: t, ...noServiceRebootAt },
      event: appendDetail(makeErrorEvent(t, "error", e), diagnostics),
    };
  }
  return {
    state: {
      ...state,
      stuckStreak: 0,
      dataToggledAt: null,
      internetFailures: 0,
      reconnectStreak: 0,
      lastReconnectAt: null,
      lastRebootAt: t,
      noServiceSince: noServiceReboot ? state.noServiceSince : null,
      ...noServiceRebootAt,
      reboot: { at: t, source: "watchdog", iccid: status.iccid },
    },
    event: {
      ...makeEvent(t, "rebooted", `Router stuck — restarted it (${reason})`),
      detail: event.detail,
    },
  };
}

// A no-service tick may reboot: the first time once the outage has lasted
// NO_SERVICE_FIRST_REBOOT_AFTER_MS, then each time the gap for the number of
// reboots so far (NO_SERVICE_REBOOT_GAPS_MS) has passed since the last one.
function noServiceRebootDue(state: WatchdogState, t: number): boolean {
  if (state.noServiceSince === null) return false;
  if (
    state.noServiceRebootCount === 0 ||
    state.lastNoServiceRebootAt === null
  ) {
    return t - state.noServiceSince >= NO_SERVICE_FIRST_REBOOT_AFTER_MS;
  }
  const gap =
    NO_SERVICE_REBOOT_GAPS_MS[
      Math.min(
        state.noServiceRebootCount - 1,
        NO_SERVICE_REBOOT_GAPS_MS.length - 1,
      )
    ];
  return t - state.lastNoServiceRebootAt >= gap;
}

// The tick events a `service-restored` notice may stand in for — informational
// ones only; any other event keeps its own and carries the notice as detail.
const SERVICE_RESTORED_REPLACES: ReadonlySet<WatchdogEventKind> = new Set([
  "ok",
  "connected",
  "recovered",
  "unlocked",
  "roaming-enabled",
  "probe-failed",
]);

// Post-processing: the first tick that sees a registered router after a
// no-service stretch (`priorSince`) announces `service-restored` — the normal
// flow already ran in the same tick, so its event is replaced (informational)
// or annotated (anything that acted). A registered status always ends the
// stretch.
function applyServiceAwareness(
  result: WatchdogTickResult,
  status: RouterStatus | undefined,
  priorSince: number | null,
): WatchdogTickResult {
  if (!status?.registered) return result;
  const state = {
    ...result.state,
    noServiceSince: null,
    noServiceRebootCount: 0,
  };
  if (priorSince === null) return { state, event: result.event };

  const message = `Mobile network back (${status.operator}, ${status.band || "n/a"})`;
  const { event } = result;
  if (!SERVICE_RESTORED_REPLACES.has(event.kind)) {
    return { state, event: appendDetail(event, message) };
  }
  const replaced =
    event.kind === "ok"
      ? undefined
      : [`${event.kind}: ${event.message}`, event.detail]
          .filter(Boolean)
          .join("\n");
  return {
    state,
    event: {
      at: event.at,
      kind: "service-restored",
      message,
      ...(replaced ? { detail: replaced } : {}),
    },
  };
}

// Which low-battery step to announce, if any: null level = armed. Charging or
// climbing back above BATTERY_REARM_LEVEL re-arms; otherwise each step of
// BATTERY_NOTICE_LEVELS is announced once, the lowest reached wins.
export function nextLowBatteryNotice(
  noticed: number | null,
  reading: Pick<BatteryReading, "level" | "charging">,
): { level: number | null; announce: boolean } {
  if (reading.charging || reading.level > BATTERY_REARM_LEVEL) {
    return { level: null, announce: false };
  }
  const reached = BATTERY_NOTICE_LEVELS.filter((l) => reading.level <= l);
  const lowest = reached.length > 0 ? Math.min(...reached) : null;
  if (lowest === null || (noticed !== null && noticed <= lowest)) {
    return { level: noticed, announce: false };
  }
  return { level: lowest, announce: true };
}

// The tick events a returned-from-the-dead router's `power-restored` may stand
// in for — informational ones only; anything that acted on the router (a
// failed reconnect, a reboot) keeps its own event and the notice waits.
const POWER_RESTORED_REPLACES: ReadonlySet<WatchdogEventKind> = new Set([
  "ok",
  "connected",
  "unlocked",
  "needs-pin",
  "no-password",
  "roaming-enabled",
  "probe-failed",
]);

// Post-processing every tick's `{ state, event }`: records the battery from the
// status the tick read and, from it, announces `battery-low` (in place of a
// plain `ok`) and `power-restored` (in place of the first informational event
// after the router was reported empty). Runs after the reboot escalation, so
// the stuck-streak logic still sees the tick's original event.
function applyBatteryAwareness(
  result: WatchdogTickResult,
  status: RouterStatus | undefined,
): WatchdogTickResult {
  const t = result.event.at;
  let { state, event } = result;
  if (event.kind === "battery-empty") {
    state = { ...state, batteryEmptyAt: state.batteryEmptyAt ?? t };
  }
  if (!status) return { state, event };

  const reading: BatteryReading = {
    level: status.battChargeLevel,
    charging: status.charging,
    at: t,
  };
  state = { ...state, lastBattery: reading };
  if (!reading.charging && reading.level <= BATTERY_LOW_LEVEL) {
    event = { ...event, batteryLow: reading.level };
  }

  if (
    state.batteryEmptyAt !== null &&
    POWER_RESTORED_REPLACES.has(event.kind)
  ) {
    const power = reading.charging ? "charging" : "not charging";
    const replaced =
      event.kind === "ok"
        ? undefined
        : [`${event.kind}: ${event.message}`, event.detail]
            .filter(Boolean)
            .join("\n");
    event = {
      at: t,
      kind: "power-restored",
      message: `Router back on power (battery ${reading.level}%, ${power})`,
      ...(replaced ? { detail: replaced } : {}),
      ...(event.batteryLow !== undefined
        ? { batteryLow: event.batteryLow }
        : {}),
    };
    state = { ...state, batteryEmptyAt: null };
  }

  const notice = nextLowBatteryNotice(state.lowBatteryNoticeLevel, reading);
  // Only a plain `ok` tick is replaced — any other event carries information
  // the notice must not hide; the announcement then waits for the next `ok`.
  if (!notice.announce) {
    return { state: { ...state, lowBatteryNoticeLevel: notice.level }, event };
  }
  if (event.kind !== "ok") return { state, event };
  return {
    state: { ...state, lowBatteryNoticeLevel: notice.level },
    event: {
      ...makeEvent(
        t,
        "battery-low",
        `Router battery ${reading.level}% — plug it in`,
      ),
      batteryLow: reading.level,
    },
  };
}

// The last battery reading says an unreachable router has run empty: not
// charging, at/below BATTERY_EMPTY_LEVEL, and recent enough to still mean it.
function emptyBatteryReading(
  battery: BatteryReading | null | undefined,
  t: number,
): BatteryReading | null {
  if (!battery || battery.charging) return null;
  if (battery.level > BATTERY_EMPTY_LEVEL) return null;
  if (t - battery.at > BATTERY_EMPTY_MAX_AGE_MS) return null;
  return battery;
}

async function wwanDiagnostics(
  client: NetgearClient,
  fallback: RouterStatus | undefined,
): Promise<string | null> {
  const latest = await client.getStatus().catch(() => fallback);
  if (!latest) return null;
  return `wwan.connection=${latest.connection}, wwan.inactivityCause=${latest.inactivityCause || "n/a"}`;
}

// Events that mark an incident — they carry the radio context so an outage
// can later be correlated with conditions (carrier-side drops, 2026-10-05).
const INCIDENT_KINDS: ReadonlySet<WatchdogEventKind> = new Set([
  "probe-failed",
  "reconnected",
  "reconnect-failed",
  "connect-failed",
  "data-toggled",
  "data-toggle-failed",
  "rebooted",
  "recovered",
  "no-service",
]);

// From the status the tick already read — no extra request.
export function incidentContext(status: RouterStatus): string {
  const text = (value: string) => value || "n/a";
  const num = (value: number | null) => (value === null ? "n/a" : value);
  return `band=${text(status.band)} radio=${status.radioQuality}% operator=${text(status.operator)} rat=${text(status.connectionText)} rsrp=${num(status.rsrp)} rsrq=${num(status.rsrq)} sinr=${num(status.sinr)}`;
}

function appendDetail(
  event: WatchdogEvent,
  extra: string | null,
): WatchdogEvent {
  if (!extra) return event;
  return { ...event, detail: [event.detail, extra].filter(Boolean).join("\n") };
}

// One pass: reachability → login → SIM state → connection → internet
// reachability, taking the least-surprising action at each step and always
// resolving to a `{ state, event }` pair — this never throws, so a caller can
// persist the result and update the command's subtitle unconditionally.
async function runTick(
  opts: RunWatchdogTickOptions,
  seen: TickSeen,
): Promise<WatchdogTickResult> {
  const {
    client,
    password,
    pinStore,
    probeInternet,
    now = defaultNow,
    sleep = defaultSleep,
    wifi,
    credsStore,
    onAction,
    budgetMs = DEFAULT_WATCHDOG_BUDGET_MS,
  } = opts;
  const t = now();
  let timeouts = scaledTimeouts(budgetMs);

  // Soft-reset step of the escalation ladder, run instead of the tick's
  // connect/reconnect. `toggleData` always ends on `Always`, so roaming stays
  // on whatever happens.
  const toggleDataTick = async (
    state: WatchdogState,
  ): Promise<WatchdogTickResult> => {
    const nextState = { ...state, dataToggledAt: t, internetFailures: 0 };
    try {
      await onAction?.("toggling-data");
      await toggleData({ client, now, sleep, timeouts });
    } catch (e) {
      return {
        state: nextState,
        event: makeErrorEvent(t, "data-toggle-failed", e),
      };
    }
    return {
      state: nextState,
      event: makeEvent(
        t,
        "data-toggled",
        "Mobile data switched off/on to reset the connection",
      ),
    };
  };

  // Only a marker inside the recovery window makes an unreachable router
  // expected and gets it recovered; a stale one is dropped (see
  // REBOOT_MARKER_TTL_MS).
  const marker = activeRebootMarker(opts.state.reboot, t);
  const state: WatchdogState =
    opts.state.reboot && t - opts.state.reboot.at >= REBOOT_MARKER_TTL_MS
      ? { ...opts.state, reboot: null }
      : opts.state;

  let status: RouterStatus;
  try {
    status = await client.getStatus();
  } catch {
    if (marker) {
      // The outage is our own reboot: rejoin at once with only the short
      // post-reboot backoff — but never while the Mac has internet through
      // another network (e.g. the user switched to a phone hotspot; seen
      // live 2026-10-06 11:5x: the rejoin kept pulling the Mac back).
      const online = await probeInternet().catch(() => false);
      if (online) {
        return {
          state,
          event: makeEvent(
            t,
            "rebooting",
            "Router restarting — Mac is online elsewhere, not switching Wi-Fi",
          ),
        };
      }
      const rejoin = await rejoinWifi({
        t,
        state,
        client,
        now,
        sleep,
        wifi,
        credsStore,
        backoffMs: POST_REBOOT_REJOIN_BACKOFF_MS,
        onAction,
      });
      return (
        rejoin ?? {
          state,
          event: makeEvent(
            t,
            "rebooting",
            "Router restarting — waiting for it to come back",
          ),
        }
      );
    }
    // Mac not on the router's Wi-Fi (e.g. at home), router off, or a
    // transient LAN hiccup. Only ever tries to fix that by rejoining the
    // router's own Wi-Fi when the Mac has literally no internet at all
    // (probeInternet fails too) — a normal home network with real internet
    // never triggers this, so the watchdog still never hijacks the Mac's
    // connection while at home.
    //
    // A router whose last reading was an empty battery is most likely just
    // off: say so, and only look for its Wi-Fi now and then in case it was
    // plugged in (the first successful tick then reports `power-restored`).
    const empty = emptyBatteryReading(state.lastBattery, t);
    let nextState = state;
    if (wifi && credsStore) {
      const online = await probeInternet().catch(() => false);
      if (!online) {
        const rejoin = await rejoinWifi({
          t,
          state,
          client,
          now,
          sleep,
          wifi,
          credsStore,
          backoffMs: empty
            ? BATTERY_EMPTY_REJOIN_BACKOFF_MS
            : REJOIN_BACKOFF_MS,
          onAction,
        });
        if (rejoin && (!empty || rejoin.event.kind === "rejoined")) {
          return rejoin;
        }
        if (rejoin) nextState = rejoin.state;
      }
    }
    if (empty) {
      return {
        state: nextState,
        event: makeEvent(
          t,
          "battery-empty",
          `Router off — battery was ${empty.level}% at ${timeOf(empty.at)}. Plug it in.`,
        ),
      };
    }
    return {
      state: nextState,
      event: makeEvent(t, "idle", "Router not reachable"),
    };
  }
  seen.status = status;

  try {
    if (status.userRole !== "Admin") {
      if (!password) {
        return {
          state,
          event: makeEvent(t, "no-password", "No admin password available"),
        };
      }
      status = await client.login(password);
      seen.status = status;
    }

    if (status.simStatus === "Locked") {
      // autoUnlockIfPossible already enforces the one-automatic-attempt
      // rule and retry guards (see flows.ts) — a rejected PIN throws, which
      // is exactly as final as "no PIN available" for this tick.
      await onAction?.("unlocking");
      const unlocked = await autoUnlockIfPossible({
        client,
        pinStore,
        status,
        knownIccid: marker?.iccid,
        now,
        sleep,
        timeouts,
      }).catch(() => null);
      if (!unlocked) {
        return {
          state,
          event: makeEvent(
            t,
            "needs-pin",
            "SIM locked — open Netgear to enter PIN",
          ),
        };
      }
      await onAction?.("connecting");
      await ensureConnected({ client, now, sleep, timeouts });
      return {
        state: { ...state, internetFailures: 0 },
        event: makeEvent(t, "unlocked", "SIM unlocked"),
      };
    }

    if (status.simStatus !== "Ready") {
      return {
        state,
        event: makeEvent(t, "sim-problem", `SIM ${status.simStatus}`),
      };
    }

    // Data roaming is meant to be always on (`wwan.autoconnect === "Always"`).
    // An unreadable value ("") is unknown, not off — never write on a guess.
    // One write, then the next tick carries on with the connection checks.
    const roamingDue =
      state.lastRoamingAttemptAt === null ||
      t - state.lastRoamingAttemptAt >= ROAMING_BACKOFF_MS;
    if (status.autoconnect && !status.roamingAllowed && roamingDue) {
      const nextState = { ...state, lastRoamingAttemptAt: t };
      try {
        await client.setRoaming(true);
      } catch (e) {
        return { state: nextState, event: makeErrorEvent(t, "error", e) };
      }
      return {
        state: nextState,
        event: makeEvent(
          t,
          "roaming-enabled",
          `Data roaming re-enabled (was ${status.autoconnect})`,
        ),
      };
    }

    // No mobile network: connecting, toggling data or rebooting cannot help
    // (2026-10-06, limited service for an hour) — wait for coverage instead.
    if (!status.registered) {
      const restarted =
        marker !== null && rebootCompleted(status.uptimeSeconds, marker.at, t);
      return {
        state: {
          ...state,
          internetFailures: 0,
          reconnectStreak: 0,
          noServiceSince: state.noServiceSince ?? t,
          // The router did come back from our restart; it just has no network.
          reboot: restarted ? null : state.reboot,
        },
        event: makeEvent(t, "no-service", NO_SERVICE_MESSAGE),
      };
    }

    if (status.connection !== "Connected") {
      // No data toggle here: on a router stuck Disconnected (connect accepted,
      // nothing happens) it failed 2/2 live on 2026-10-05 — only a reboot
      // cleared it, so that case reboots one tick earlier instead (see
      // STUCK_DISCONNECTED_REBOOT_THRESHOLD).
      try {
        await onAction?.("connecting");
        const connected = await ensureConnected({
          client,
          now,
          sleep,
          timeouts,
        });
        return {
          state: { ...state, internetFailures: 0 },
          event: makeEvent(
            t,
            "connected",
            `Connected · ${connected.connectionText || connected.connection}`,
          ),
        };
      } catch (e) {
        return {
          state,
          event: makeErrorEvent(t, "connect-failed", e),
        };
      }
    }

    let online = await probeInternet();
    let failures = state.internetFailures + 1;
    // First failure of an outage: confirm within this tick rather than a tick
    // later. Only when it would otherwise just wait (below threshold, backoff
    // elapsed) and the budget fits it — else the cross-tick counting applies.
    if (
      !online &&
      failures < INTERNET_FAILURE_THRESHOLD &&
      reconnectBackoffElapsed(state, t) &&
      budgetMs - CONFIRM_COST_MS >= MIN_ACTION_BUDGET_MS
    ) {
      await sleep(CONFIRM_DELAY_MS);
      online = await probeInternet();
      failures = INTERNET_FAILURE_THRESHOLD;
      timeouts = scaledTimeouts(budgetMs - CONFIRM_COST_MS);
    }
    if (online) {
      // Right after the reboot POST the router can still answer for a few
      // seconds — the old session looks healthy, so the marker stays until
      // its uptime shows it actually restarted.
      const restarted =
        marker !== null && rebootCompleted(status.uptimeSeconds, marker.at, t);
      return {
        state: {
          ...state,
          internetFailures: 0,
          reconnectStreak: 0,
          reboot: marker && !restarted ? state.reboot : null,
        },
        event: restarted
          ? makeEvent(t, "recovered", "Back online after restart")
          : makeEvent(
              t,
              "ok",
              `OK · ${status.connectionText || status.connection}`,
            ),
      };
    }

    const backoffMs = reconnectBackoffMs(state.reconnectStreak);
    const backoffElapsed = reconnectBackoffElapsed(state, t);

    // Still no internet after the reconnects — or about to reconnect: the
    // second stuck tick takes the soft reset instead.
    if (
      shouldToggleData(state) &&
      (state.reconnectStreak >= 2 ||
        (failures >= INTERNET_FAILURE_THRESHOLD && backoffElapsed))
    ) {
      return await toggleDataTick(state);
    }

    if (failures < INTERNET_FAILURE_THRESHOLD || !backoffElapsed) {
      return {
        state: { ...state, internetFailures: failures },
        event: makeEvent(
          t,
          "probe-failed",
          backoffElapsed
            ? `Internet check failed (${failures}/${INTERNET_FAILURE_THRESHOLD})`
            : `Internet still down — next reconnect after ${timeOf(
                (state.lastReconnectAt ?? t) + backoffMs,
              )}`,
        ),
      };
    }

    try {
      await onAction?.("reconnecting");
      await reconnect({ client, now, sleep, timeouts });
      return {
        state: {
          ...state,
          internetFailures: 0,
          lastReconnectAt: t,
          reconnectStreak: state.reconnectStreak + 1,
        },
        event: makeEvent(
          t,
          "reconnected",
          "Reconnected after failed internet checks",
        ),
      };
    } catch (e) {
      return {
        state: {
          ...state,
          internetFailures: failures,
          lastReconnectAt: t,
          reconnectStreak: state.reconnectStreak + 1,
        },
        event: makeErrorEvent(t, "reconnect-failed", e),
      };
    }
  } catch (e) {
    return { state, event: makeErrorEvent(t, "error", e) };
  }
}

// Whether the router answers at all, polled for up to
// REJOIN_REACHABLE_WAIT_MS — it can take a moment after the Mac joined.
async function routerReachable(opts: {
  client: NetgearClient;
  now: Now;
  sleep: Sleep;
}): Promise<boolean> {
  const { client, now, sleep } = opts;
  const deadline = now() + REJOIN_REACHABLE_WAIT_MS;
  const attempts = Math.ceil(REJOIN_REACHABLE_WAIT_MS / REJOIN_POLL_MS) + 1;
  for (let i = 0; i < attempts; i++) {
    if (
      await client.getModel().then(
        () => true,
        () => false,
      )
    )
      return true;
    if (i === attempts - 1 || now() >= deadline) return false;
    await sleep(REJOIN_POLL_MS);
  }
  return false;
}

// Rejoins the router's Wi-Fi with the persisted credentials, at most once per
// `backoffMs`. The rejoin only counts (`rejoined`) if the router answers
// afterwards — networksetup reports a join of an SSID that is not on air as
// fine. Null when nothing was attempted (no creds/rejoiner, or backed off) —
// the caller then picks its own "nothing happened" event.
async function rejoinWifi(opts: {
  t: number;
  state: WatchdogState;
  client: NetgearClient;
  now: Now;
  sleep: Sleep;
  wifi?: WifiRejoiner;
  credsStore?: WifiCredsStore;
  backoffMs: number;
  onAction?: RunWatchdogTickOptions["onAction"];
}): Promise<WatchdogTickResult | null> {
  const {
    t,
    state,
    client,
    now,
    sleep,
    wifi,
    credsStore,
    backoffMs,
    onAction,
  } = opts;
  if (!wifi || !credsStore) return null;
  const last = state.lastRejoinAttemptAt;
  if (last !== null && t - last < backoffMs) return null;
  const creds = await credsStore.get().catch(() => null);
  if (!creds) return null;
  await onAction?.("rejoining");
  const nextState = { ...state, lastRejoinAttemptAt: t };
  const joined = await wifi.rejoin(creds).catch(() => false);
  if (!joined) {
    return {
      state: nextState,
      event: makeEvent(t, "rejoin-failed", "Wi-Fi rejoin did not succeed"),
    };
  }
  if (!(await routerReachable({ client, now, sleep }))) {
    return {
      state: nextState,
      event: makeEvent(
        t,
        "rejoin-failed",
        "Router not found on Wi-Fi — off or out of battery?",
      ),
    };
  }
  return {
    state: nextState,
    event: makeEvent(t, "rejoined", `Rejoined Wi-Fi "${creds.ssid}"`),
  };
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// One short line for the command's launcher subtitle
// (`updateCommandMetadata`) — the only surface a no-view background run has.
export function formatSubtitle(event: WatchdogEvent): string {
  switch (event.kind) {
    case "ok":
    case "connected":
    case "unlocked":
    case "reconnected":
    case "rejoined":
    case "roaming-enabled":
    case "recovered":
    case "service-restored":
    case "power-restored": {
      const battery =
        event.batteryLow === undefined ? "" : ` · 🔋${event.batteryLow}%`;
      return `${event.message}${battery} · ${timeOf(event.at)}`;
    }
    case "battery-low":
    case "battery-empty":
      return `🔋 ${event.message}`;
    case "data-toggled":
      return `Data reset · ${timeOf(event.at)}`;
    case "rebooted":
      return `Restarted router · ${timeOf(event.at)}`;
    case "rebooting":
      return "Router restarting…";
    case "idle":
      return `Idle · ${event.message}`;
    case "no-service":
      return `No service · ${timeOf(event.at)}`;
    case "needs-pin":
      return "SIM PIN needed";
    case "sim-problem":
    case "no-password":
      return event.message;
    case "probe-failed":
      return `Checking… · ${timeOf(event.at)}`;
    case "connect-failed":
    case "reconnect-failed":
    case "rejoin-failed":
    case "data-toggle-failed":
    case "error":
      return `Failed · ${timeOf(event.at)}`;
    case "in-progress":
    case "deferred":
      return event.message;
    default:
      return event.message;
  }
}
