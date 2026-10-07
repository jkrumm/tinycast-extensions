// Pure Detail markdown for netgear.tsx's status view — the hero image, SIM
// warnings, and a compact table of everything the hero/header don't already
// carry. No `@raycast/api` import (only `import type` for `WatchdogStorage`,
// which does), so this runs under vitest — see status-view.test.ts.

import { statCards, statusPanel, thresholdColor, toDataUri } from "../lib/svg";
import type { PanelColumn, StatCard } from "../lib/svg";
import { RouterStatus } from "./types";
import { signalRow } from "./signal-view";
import type { ActionLockHolder } from "./action-lock";
import {
  activeRebootMarker,
  formatSubtitle,
  rebootCompleted,
  REBOOT_MARKER_TTL_MS,
  RebootMarker,
  WatchdogEvent,
} from "./watchdog";
import type { WatchdogStorage } from "./watchdog-storage";

// Radio quality reads differently from a quota percentage — LTE signal
// rarely climbs past 60-70% even on a strong connection, so the usual 50/80
// split reads a merely-good signal as red. 60/35 instead.
const RADIO_QUALITY_LOW = 35;
const RADIO_QUALITY_HIGH = 60;

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(seconds / 60)} min`;
}

// Radio quality (with band and operator) and the router's own battery, as a
// status panel — a compact replacement for the old row of three big glyphs.
export function panelColumns(status: RouterStatus): PanelColumn[] {
  return [
    {
      label: "Signal",
      value: status.radioQuality,
      unit: "%",
      percent: status.radioQuality,
      color: thresholdColor(status.radioQuality, {
        invert: true,
        lowBoundary: RADIO_QUALITY_LOW,
        highBoundary: RADIO_QUALITY_HIGH,
      }),
      sub: `${status.band || "—"} · ${status.operator || "no operator"}`,
    },
    {
      label: "Battery",
      value: status.battChargeLevel,
      unit: "%",
      percent: status.battChargeLevel,
      gauge: "battery",
      color: thresholdColor(status.battChargeLevel, {
        invert: true,
        lowBoundary: 20,
        highBoundary: 40,
      }),
      sub: status.charging ? "Charging" : "On battery",
    },
  ];
}

export function panelImage(status: RouterStatus): string {
  return toDataUri(statusPanel({ columns: panelColumns(status) }));
}

// The quiet metrics row: whether the internet check passes (toned), data used
// this cycle, uptime and connected clients. Text-ish reference fields (roaming,
// APN, PIN, unread SMS, SIM operator) stay in the table below.
export function metricCards(
  status: RouterStatus,
  internet: boolean | null,
): StatCard[] {
  const cards: StatCard[] = [
    {
      label: "Internet",
      value: internet === null ? null : internet ? "Online" : "Offline",
      tone: internet === null ? "neutral" : internet ? "good" : "bad",
    },
    { label: "Data (cycle)", value: status.dataTransferredGB, unit: "GB" },
    { label: "Uptime", value: formatUptime(status.uptimeSeconds) },
  ];
  if (status.connectedClients !== null) {
    cards.push({ label: "Clients", value: status.connectedClients });
  }
  return cards;
}

export function metricsImage(
  status: RouterStatus,
  internet: boolean | null,
): string {
  const cards = metricCards(status, internet);
  return toDataUri(
    statCards({ cards, size: "compact", columns: cards.length }),
  );
}

function simStatusWarning(status: RouterStatus): string | null {
  switch (status.simStatus) {
    case "Ready":
      return null;
    case "Locked":
      return "🔒 **SIM locked** — enter the PIN to unlock (see the SIM actions below).";
    case "Blocked":
      return "🚫 **SIM blocked** — PUK required to unlock.";
    case "NotPresent":
      return "📭 **No SIM detected** — insert a SIM card.";
    default:
      return `⚠️ **SIM: ${status.simStatus}**`;
  }
}

// `| | | | |` with zero-width headers (see the tinycast skill § tables),
// two label/value pairs per row; an odd last pair is padded with blanks.
function pairTable(pairs: [string, string][]): string[] {
  const rows = ["| | | | |", "|-|-|-|-|"];
  for (let i = 0; i < pairs.length; i += 2) {
    const [a, b = ["", ""]] = [pairs[i], pairs[i + 1]];
    rows.push(`| ${a[0]} | ${a[1]} | ${b[0]} | ${b[1]} |`);
  }
  return rows;
}

const WATCHDOG_RECENT_EVENTS = 6;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// A collapsed run of routine ticks shows its span ("10:27–11:12"), anything
// else the single time it happened.
function eventTime(e: WatchdogEvent): string {
  return e.firstAt !== undefined && clock(e.firstAt) !== clock(e.at)
    ? `${clock(e.firstAt)}–${clock(e.at)}`
    : clock(e.at);
}

function eventGlyph(kind: WatchdogEvent["kind"]): string {
  switch (kind) {
    case "ok":
      return "✓";
    case "connected":
    case "reconnected":
    case "rejoined":
    case "unlocked":
    case "roaming-enabled":
    case "data-toggled":
      return "↻";
    case "probe-failed":
    case "needs-pin":
    case "sim-problem":
    case "no-password":
      return "⚠︎";
    case "connect-failed":
    case "reconnect-failed":
    case "rejoin-failed":
    case "data-toggle-failed":
    case "error":
      return "✗";
    case "rebooted":
    case "rebooting":
    case "recovered":
      return "⏻";
    case "battery-low":
    case "battery-empty":
    case "power-restored":
      return "🔋";
    case "no-service":
      return "📵";
    case "service-restored":
      return "↻";
    default:
      return "·";
  }
}

// The watchdog's own section: a heading with its state and the last hour's
// drop count, then its most recent events. `in-progress` breadcrumbs are
// left out — the 🔄 line at the top already covers a live one, and a stale
// one is always followed by the event that finished it.
export function watchdogSection(
  watchdog: WatchdogStorage | undefined,
  now: number = Date.now(),
  runningHere = false,
): string[] {
  if (!watchdog) return ["### Watchdog · —"];
  const state = watchdog.enabled ? "On" : "Paused";
  const drops = countDrops(watchdog.events, now);
  const dropText = `${drops} ${drops === 1 ? "drop" : "drops"} in the last hour`;
  const here =
    runningHere && watchdog.enabled
      ? " · running here while this view is open"
      : "";
  const lines = [`### Watchdog · ${state} · ${dropText}${here}`];
  const recent = watchdog.events
    .filter((e) => e.kind !== "in-progress")
    .slice(0, WATCHDOG_RECENT_EVENTS);
  if (recent.length === 0) {
    lines.push(
      "",
      "_Watchdog has never run — enable it once in Tinycast Settings → Extensions → Netgear Watchdog → Background Refresh._",
    );
    return lines;
  }
  lines.push("", "| | | |", "|-|-|-|");
  for (const e of recent) {
    const count = e.count && e.count > 1 ? ` ×${e.count}` : "";
    lines.push(
      `| ${eventTime(e)} | ${eventGlyph(e.kind)} | ${e.message.replace(/\|/g, "\\|")}${count} |`,
    );
  }
  return lines;
}

const HOUR_MS = 60 * 60_000;
// An `in-progress` breadcrumb is only "live" for about as long as a watchdog
// tick can run (its hard budget plus slack) — older than this the tick was
// killed or finished without writing its final event.
const IN_PROGRESS_FRESH_MS = 90_000;

// Connection drops the watchdog had to repair in the last hour: it either
// had to connect a Disconnected router ("connected") or reconnect one whose
// internet was dead ("reconnected"). Collapsing in the log only ever merges
// ok/idle/deferred ticks, so these are always one event each.
export function countDrops(
  events: readonly WatchdogEvent[],
  now: number = Date.now(),
): number {
  return events.filter(
    (e) =>
      (e.kind === "connected" || e.kind === "reconnected") &&
      now - e.at <= HOUR_MS,
  ).length;
}

// What the watchdog is doing right now, for a "🔄 Watchdog: …" line — its
// newest event is a fresh `in-progress` breadcrumb, or it holds the router
// action lock. Null when it is idle.
export function watchdogActivity(opts: {
  watchdog: WatchdogStorage | undefined;
  lockHolder?: ActionLockHolder | null;
  now?: number;
}): string | null {
  const { watchdog, lockHolder, now = Date.now() } = opts;
  const last = watchdog?.events[0];
  if (last?.kind === "in-progress" && now - last.at < IN_PROGRESS_FRESH_MS) {
    return last.message.replace(/^In progress:\s*/, "");
  }
  if (lockHolder?.owner === "watchdog" && now <= lockHolder.expiresAt) {
    return "running a check…";
  }
  return null;
}

// The "what happens next" half of the no-internet warning, derived from the
// watchdog's newest event — its own messages already carry the next-reconnect
// time, so this reuses them instead of redoing the backoff math.
function watchdogNextStep(watchdog: WatchdogStorage | undefined): string {
  if (!watchdog) return "";
  if (!watchdog.enabled) return "The watchdog is paused.";
  const last = watchdog.events[0];
  if (!last) return "The watchdog has not run yet.";
  if (last.kind === "probe-failed") {
    return /next reconnect after/.test(last.message)
      ? `${last.message}.`
      : `${last.message} — the watchdog reconnects after the next failed check.`;
  }
  return `Last watchdog run: ${formatSubtitle(last)}.`;
}

// Roaming is meant to be always on — the watchdog re-enables it, so "off" is
// a transient state, not a setting.
export function roamingRow(status: RouterStatus): string {
  if (!status.roamingAllowed) return "Off — watchdog re-enables";
  if (!status.currentlyRoaming) return "Allowed · home network";
  return status.operator
    ? `Allowed · roaming now (${status.operator})`
    : "Allowed · roaming now";
}

// Folds lock mode + retries-left + saved-PIN state into one row, e.g.
// "Lock on · 3 tries · saved" — retries are only meaningful while the lock
// is actually enabled.
function pinRow(status: RouterStatus, hasSavedPin: boolean): string {
  const parts = [status.simPinMode === "Enabled" ? "Lock on" : "Lock off"];
  if (status.simPinMode === "Enabled") {
    const tries = status.simPinRetry === 1 ? "try" : "tries";
    parts.push(`${status.simPinRetry} ${tries}`);
  }
  if (hasSavedPin) parts.push("saved");
  return parts.join(" · ");
}

// What the loader learned beyond the router's own model: a real internet
// probe (the router's `Connected` only proves the radio link is up) and who,
// if anyone, holds the router action lock.
export interface LiveState {
  internet: boolean | null; // null: the probe itself failed to run
  lockHolder?: ActionLockHolder | null;
  // The latest refresh failed, so `status` is a cached one — its battery
  // reading is old news and gets no warning line.
  stale?: boolean;
  // The open view is running the watchdog's ticks itself (Tinycast runs no
  // background command while a foreground one is open) — adds a heading note
  // and the close-with-Esc tip.
  watchdogInView?: boolean;
  now?: number;
}

export const CLOSE_TIP =
  "_Press Esc to close — Tinycast pauses the background watchdog while a command window is open._";

const BATTERY_WARNING_LEVEL = 20;

function batteryWarning(status: RouterStatus): string | null {
  if (status.charging || status.battChargeLevel > BATTERY_WARNING_LEVEL) {
    return null;
  }
  return `> 🔋 **Router battery ${status.battChargeLevel}%** — not charging.`;
}

// The offline banner's label: the router being off with an empty battery is a
// different fix (plug it in) from it merely not being reachable.
export function offlineLabel(watchdog: WatchdogStorage | undefined): string {
  const last = watchdog?.events.find((e) => e.kind !== "in-progress");
  return last?.kind === "battery-empty" ? last.message : "Router not reachable";
}

// A Ready SIM whose router sees cells but isn't registered on any (limited
// service) — a Locked SIM hides its operator, which is a different story.
export function noService(status: RouterStatus): boolean {
  return status.simStatus === "Ready" && !status.registered;
}

const NO_SERVICE_WARNING =
  "> 📵 **No mobile network** — the router sees cells but isn't allowed to register (limited service). **Restart & Reconnect** usually fixes this if coverage is good here.";

function headline(status: RouterStatus, internet: boolean | null): string {
  if (noService(status)) return "No service";
  if (status.connection !== "Connected") return status.connection;
  const text = status.connectionText || status.connection;
  return internet === false ? `${text} · No internet` : text;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The banner for a router restart this extension triggered (reboot marker):
// "restarting" while the marker is inside the recovery window and the router
// hasn't come back, a warning with the Rejoin hint once it overstays, null
// when there is no marker or the router is back Connected + online. While
// `restarting` the router being unreachable is expected, so the caller shows
// this instead of the generic "Router not reachable" banner.
export function rebootBanner(opts: {
  marker: RebootMarker | null | undefined;
  status: RouterStatus | undefined;
  internet: boolean | null;
  // When `status` was fetched, and whether the latest refresh failed — a
  // cached pre-reboot status must not count as "back".
  fetchedAt: number | undefined;
  error: unknown;
  now?: number;
}): { markdown: string; restarting: boolean } | null {
  const { marker, status, internet, fetchedAt, error, now = Date.now() } = opts;
  if (!marker) return null;
  const back =
    !!status &&
    !error &&
    fetchedAt !== undefined &&
    fetchedAt > marker.at &&
    status.connection === "Connected" &&
    internet === true &&
    rebootCompleted(status.uptimeSeconds, marker.at, now);
  if (back) return null;
  if (activeRebootMarker(marker, now)) {
    return {
      markdown: `> 🔄 Router restarting… (${elapsed(now - marker.at)} elapsed)`,
      restarting: true,
    };
  }
  if (now - marker.at >= REBOOT_MARKER_TTL_MS) return null;
  return {
    markdown:
      "> ⚠️ **Router did not come back after the restart** — use Rejoin Router Wi-Fi, or check the router.",
    restarting: false,
  };
}

export function statusMarkdown(
  status: RouterStatus,
  hasSavedPin: boolean,
  watchdog: WatchdogStorage | undefined,
  live: LiveState = { internet: null },
): string {
  const {
    internet,
    lockHolder,
    stale = false,
    watchdogInView = false,
    now = Date.now(),
  } = live;
  const panel = panelImage(status);
  const lines = [`# ${headline(status, internet)}`];
  const lowBattery = stale ? null : batteryWarning(status);
  if (lowBattery) lines.push("", lowBattery);
  if (noService(status)) lines.push("", NO_SERVICE_WARNING);
  const activity = watchdogActivity({ watchdog, lockHolder, now });
  if (activity) lines.push("", `> 🔄 Watchdog: ${activity}`);
  if (status.connection === "Connected" && internet === false) {
    const next = watchdogNextStep(watchdog);
    lines.push(
      "",
      `> ⚠️ **No internet** — the router reports Connected, but the internet check fails.${next ? ` ${next}` : ""}`,
    );
  }
  lines.push("", `![Status](${panel})`);
  lines.push("", `![Metrics](${metricsImage(status, internet)})`);
  const warning = simStatusWarning(status);
  if (warning) lines.push("", warning);
  if (status.userRole !== "Admin") {
    lines.push(
      "",
      "_Guest session — set the Netgear Admin Password preference to unlock actions._",
    );
  }

  const activeProfile = status.profiles.find(
    (p) => p.id === status.activeProfileId,
  );

  // No Detail.Metadata sidebar — the heroes above carry signal, band/operator
  // and battery %, the stat cards the numbers (internet, data, uptime,
  // clients); a table covers the long-tail reference text (see
  // AGENTS.md § Metadata). Two label/value pairs per row: the markdown
  // pane is the full ~730pt column, so a 2-column table wastes half of it.
  const pairs: [string, string][] = [
    ["Roaming", roamingRow(status)],
    [
      "APN",
      activeProfile ? `${activeProfile.name} · ${activeProfile.apn}` : "—",
    ],
    ["PIN", pinRow(status, hasSavedPin)],
  ];
  const signal = signalRow(status);
  if (signal) pairs.push(["Signal", signal]);
  if (status.smsUnread > 0) pairs.push(["SMS", `${status.smsUnread} unread`]);
  if (status.simOperator && status.simOperator !== status.operator) {
    pairs.push(["SIM operator", status.simOperator]);
  }
  lines.push("", ...pairTable(pairs));

  lines.push("", ...watchdogSection(watchdog, now, watchdogInView));
  if (watchdogInView) lines.push("", CLOSE_TIP);

  return lines.join("\n");
}
