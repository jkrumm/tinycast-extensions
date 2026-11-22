// Pure half of the WalkingPad commands: defensive parsing of the host's JSON,
// the belt phase, the speed grid, and every line of text. No @raycast/api.

import { PadStatus, Phase, Totals, WalkSession } from "./types";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

const zeroTotals = (): Totals => ({
  durationS: 0,
  distanceM: 0,
  steps: 0,
  kcal: 0,
});

function totals(v: unknown): Totals {
  if (!isObject(v)) return zeroTotals();
  return {
    durationS: num(v.duration_s) ?? 0,
    distanceM: num(v.distance_m) ?? 0,
    steps: num(v.steps) ?? 0,
    kcal: num(v.kcal) ?? 0,
  };
}

function session(v: unknown): WalkSession | null {
  if (!isObject(v)) return null;
  return {
    ...totals(v),
    startedAt: str(v.started_at),
    avgSpeedKmh: num(v.avg_speed_kmh),
    maxSpeedKmh: num(v.max_speed_kmh),
  };
}

// Malformed input, or an object that is not a status, yields null.
export function parseStatus(raw: string): PadStatus | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(json) || typeof json.connected !== "boolean") return null;
  return {
    connected: json.connected,
    beltState: str(json.belt_state)?.toLowerCase() ?? null,
    speedKmh: num(json.speed_kmh),
    session: session(json.current_session),
    today: totals(json.today),
    adapterError: str(json.adapter_error),
  };
}

export function phaseOf(status: PadStatus): Phase {
  if (!status.connected) return "padDisconnected";
  switch (status.beltState) {
    case "starting":
      return "starting";
    case "active":
      return "active";
    case "stopping":
      return "stopping";
    default:
      // stopped, standby, a state the host cannot decode yet: the belt stands.
      return "standby";
  }
}

// ─── Speed grid (mirrors PadKit's SpeedRange) ───────────────────────────────

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 6.0;
export const SPEED_STEP = 0.5;
export const DEFAULT_START_SPEED = 3.0;
export const SPEED_PRESETS = [3.0, 3.5, 4.0, 4.5, 5.0] as const;

// Into the range, rounded to 0.1 as the host rounds.
export const clampSpeed = (kmh: number): number =>
  Math.min(Math.max(Math.round(kmh * 10) / 10, SPEED_MIN), SPEED_MAX);

// The next grid speed above (steps > 0) or below the current one: 3.2 goes up
// to 3.5 and down to 3.0, so a speed set on the pad's remote snaps onto the grid.
export function steppedSpeed(kmh: number, steps: number): number {
  if (steps === 0) return clampSpeed(kmh);
  const position = kmh / SPEED_STEP;
  const tolerance = 1e-6;
  const grid =
    steps > 0
      ? Math.floor(position + tolerance) + steps
      : Math.ceil(position - tolerance) + steps;
  return clampSpeed(grid * SPEED_STEP);
}

// ─── Text ───────────────────────────────────────────────────────────────────

export const formatSpeed = (kmh: number | null): string =>
  kmh === null ? "—" : `${kmh.toFixed(1)} km/h`;

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export const formatDistance = (meters: number): string =>
  meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(2)} km`;

// Thousands separator without Intl (the runtime's locale support is unverified).
export const formatSteps = (steps: number): string =>
  String(Math.round(steps)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export const formatKcal = (kcal: number): string => `${Math.round(kcal)} kcal`;

export function phaseTitle(status: PadStatus | null): string {
  if (!status) return "WalkingPad";
  switch (phaseOf(status)) {
    case "padDisconnected":
      return "Pad not connected";
    case "standby":
      return "Ready";
    case "starting":
      return "Starting…";
    case "active":
      return `Walking · ${formatSpeed(status.speedKmh)}`;
    case "stopping":
      return "Stopping…";
  }
}

// Menu-less one-liner for the hub tile: "▶ 4.5 km/h", "Ready", "Pad off".
export function tileStatus(
  status: PadStatus | null,
  ageMs = 0,
  maxAgeMs = 5 * 60_000,
): string {
  if (!status || ageMs > maxAgeMs) return "—";
  switch (phaseOf(status)) {
    case "padDisconnected":
      return "Pad off";
    case "standby":
      return status.today.distanceM > 0
        ? `Ready · ${formatDistance(status.today.distanceM)}`
        : "Ready";
    case "starting":
      return "Starting…";
    case "active":
      return `▶ ${formatSpeed(status.speedKmh)}`;
    case "stopping":
      return "Stopping…";
  }
}

const row = (label: string, t: Totals): string =>
  `| ${label} | ${formatDuration(t.durationS)} | ${formatDistance(t.distanceM)} | ${formatSteps(t.steps)} | ${formatKcal(t.kcal)} |`;

// The Detail: one headline, the walk in progress and today's totals in one
// table (every number once).
export function statusMarkdown(status: PadStatus | null): string {
  if (!status) return "# WalkingPad\n\nNo reading yet.";
  const lines = [`# ${phaseTitle(status)}`];
  if (!status.connected) {
    lines.push(
      "",
      status.adapterError
        ? `The host's Bluetooth adapter is down: ${status.adapterError}.`
        : "The host is up but has no Bluetooth link to the pad. Switch the pad on.",
    );
  }
  const walk = status.session;
  if (walk && (walk.avgSpeedKmh !== null || walk.maxSpeedKmh !== null)) {
    lines.push(
      "",
      `Average ${formatSpeed(walk.avgSpeedKmh)} · max ${formatSpeed(walk.maxSpeedKmh)}`,
    );
  }
  lines.push("", "| | Time | Distance | Steps | Energy |", "|-|-|-|-|-|");
  if (walk) lines.push(row("Walk", walk));
  lines.push(row("Today", status.today));
  return lines.join("\n");
}
