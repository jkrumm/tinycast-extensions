// Pure logic of the `van-sampler` background command — no `@raycast/api` (the
// LocalStorage glue is sampler-storage.ts, the run itself sampler-runner.ts).
//
// Every 15 minutes the sampler takes the same live read an open of Van Power
// does and persists it the same way, so the charts, the SoC estimate and the
// daily consumption have readings while nobody looks. It can be paused (the
// user leaves the van for a month) and posts one macOS notification when the
// battery crosses down through a low threshold.

import { HelperResult, VanReading } from "./types";

export const SAMPLER_INTERVAL_MIN = 15;
// Alert once per crossing down through each; the lowest newly crossed one is
// the one reported. A threshold is re-armed once the charge is back this many
// points above it.
export const ALERT_THRESHOLDS = [30, 15] as const;
export const ALERT_REARM_MARGIN = 5;

export type SamplerResult =
  | { kind: "sampled"; soc: number | null } // soc null: only the charger was heard
  | { kind: "not-in-range" } // nothing (or no BMS) answered
  | { kind: "phone-app" } // the BMS refused: the phone app holds its one connection
  | { kind: "bluetooth"; detail: string } // off / not allowed
  | { kind: "error"; message: string };

export interface SamplerAlert {
  latched: number[]; // thresholds already reported and not yet re-armed
  threshold: number | null; // the last one reported
  at: number | null;
}

export interface SamplerState {
  paused: boolean;
  lastRunAt: number | null;
  lastResult: SamplerResult | null;
  lastAlert: SamplerAlert;
}

export const INITIAL_SAMPLER_STATE: SamplerState = {
  paused: false, // active by default
  lastRunAt: null,
  lastResult: null,
  lastAlert: { latched: [], threshold: null, at: null },
};

// A state persisted by an older build (or a damaged one) still yields a usable
// state: every field falls back to its default.
export function migrateSamplerState(raw: unknown): SamplerState {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    Record<keyof SamplerState, unknown>
  >;
  const alert = (
    typeof r.lastAlert === "object" && r.lastAlert !== null ? r.lastAlert : {}
  ) as Partial<SamplerAlert>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    paused: r.paused === true,
    lastRunAt: num(r.lastRunAt),
    lastResult:
      typeof r.lastResult === "object" &&
      r.lastResult !== null &&
      typeof (r.lastResult as { kind?: unknown }).kind === "string"
        ? (r.lastResult as SamplerResult)
        : null,
    lastAlert: {
      latched: Array.isArray(alert.latched)
        ? alert.latched.filter((v): v is number => typeof v === "number")
        : [],
      threshold: num(alert.threshold),
      at: num(alert.at),
    },
  };
}

// ─── What a run found ───────────────────────────────────────────────────────

export function classifyRead(opts: {
  reading: VanReading;
  helper: HelperResult;
}): SamplerResult {
  const { reading, helper } = opts;
  const bluetooth = helper.errors.find((e) => e.startsWith("bluetooth-"));
  if (bluetooth && !reading.battery && !reading.solar) {
    return { kind: "bluetooth", detail: bluetooth.slice("bluetooth-".length) };
  }
  if (reading.battery) return { kind: "sampled", soc: reading.battery.soc };
  if (helper.errors.includes("battery-connect-failed")) {
    return { kind: "phone-app" };
  }
  return { kind: "not-in-range" };
}

// ─── The low-battery alert ──────────────────────────────────────────────────

// One step of the alert state machine for a reading of `soc` %. A threshold
// the charge is at or below, and that is not already latched, fires and
// latches; a latched one is released once the charge is ≥ threshold + margin
// (in between it stays quiet — no flapping around the line). When a reading
// jumps through both, only the lowest is reported.
export function alertStep(
  latched: number[],
  soc: number,
): { fire: number | null; latched: number[] } {
  const next = latched.filter((t) => soc < t + ALERT_REARM_MARGIN);
  let fire: number | null = null;
  for (const t of ALERT_THRESHOLDS) {
    if (soc > t || next.includes(t)) continue;
    next.push(t);
    fire = fire === null ? t : Math.min(fire, t);
  }
  return { fire, latched: next };
}

export function alertText(soc: number, threshold: number): string {
  const rounded = Math.round(soc);
  return threshold <= 15
    ? `Van battery ${rounded} % — critically low, switch off what you can`
    : `Van battery ${rounded} % — stop charging devices from the van`;
}

// The state after one run, and the alert (if any) to post for it.
export function applyRun(
  state: SamplerState,
  opts: { now: number; result: SamplerResult },
): { state: SamplerState; alert: { threshold: number; text: string } | null } {
  const { now, result } = opts;
  const base: SamplerState = { ...state, lastRunAt: now, lastResult: result };
  if (result.kind !== "sampled" || result.soc === null) {
    return { state: base, alert: null };
  }
  const step = alertStep(state.lastAlert.latched, result.soc);
  return {
    state: {
      ...base,
      lastAlert:
        step.fire === null
          ? { ...state.lastAlert, latched: step.latched }
          : { latched: step.latched, threshold: step.fire, at: now },
    },
    alert:
      step.fire === null
        ? null
        : { threshold: step.fire, text: alertText(result.soc, step.fire) },
  };
}

// ─── Words ──────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, "0");

export const clockTime = (t: number): string => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

function resultText(result: SamplerResult): string {
  switch (result.kind) {
    case "sampled":
      return result.soc === null ? "Charger only" : `${result.soc} %`;
    case "not-in-range":
      return "Van not in range";
    case "phone-app":
      return "Phone app holds the battery";
    case "bluetooth":
      return result.detail === "off"
        ? "Bluetooth off"
        : `Bluetooth ${result.detail}`;
    case "error":
      return "Read failed";
  }
}

// The launcher subtitle ("83 % · 12:40", "Van not in range", "Paused").
export function formatSamplerSubtitle(state: SamplerState): string {
  if (state.paused) return "Paused";
  if (!state.lastResult || state.lastRunAt === null) return "Not run yet";
  const text = resultText(state.lastResult);
  return state.lastResult.kind === "sampled"
    ? `${text} · ${clockTime(state.lastRunAt)}`
    : text;
}

// The one quiet line in the Van Power view.
export function samplerStatusLine(state: SamplerState): string {
  if (state.paused) return "Background sampling paused";
  const base = `Background sampling every ${SAMPLER_INTERVAL_MIN} min`;
  if (!state.lastResult || state.lastRunAt === null) return base;
  const last = clockTime(state.lastRunAt);
  return state.lastResult.kind === "sampled"
    ? `${base} · last ${last}`
    : `${base} · last ${last}: ${resultText(state.lastResult).toLowerCase()}`;
}
