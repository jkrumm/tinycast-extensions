// Two append-only files under the extension's support dir that exist for one
// purpose: tuning the SoC estimator (`make van-eval`, see AGENTS.md § SoC
// estimator tuning loop).
//
//   van-log.jsonl     one line per Van Power open: the exact Ective reading, the
//                     Victron's live reading, and what the estimator predicted
//                     for that moment WITHOUT this reading — 60 days.
//   van-trends.jsonl  the Victron's trend samples (battery A, battery V, PV W) at
//                     native resolution, appended on every read — 30 days. The
//                     view itself still only uses 72 h; this is the long tail.
//
// Pure fs (no `@raycast/api`), only fs functions Tinycast's node shim implements
// (tinycast-runtime.test.ts), and nothing here ever throws: a broken log must
// not break the view it describes.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { VanReading } from "./types";
import { VictronTrends } from "./victron-trends";

const DAY_MS = 86_400_000;
export const CAPTURE_LOG_KEEP_MS = 60 * DAY_MS;
export const TRENDS_LOG_KEEP_MS = 30 * DAY_MS;
// A file is rewritten (trimmed) only once it has outgrown this — roughly a
// month of heavy use for the capture log, two weeks of native-resolution trends.
export const CAPTURE_LOG_TRIM_BYTES = 256 * 1024;
export const TRENDS_LOG_TRIM_BYTES = 1024 * 1024;

export const CAPTURE_LOG_FILE = "van-log.jsonl";
export const TRENDS_LOG_FILE = "van-trends.jsonl";

// ─── The capture log ────────────────────────────────────────────────────────

export interface CaptureLogEntry {
  t: number; // epoch ms of the reading
  ective: {
    soc: number;
    currentA: number; // net, + charging
    voltageV: number | null;
    capacityAh: number;
    tempC: number;
  };
  victron: {
    chargeA: number | null;
    batteryV: number | null;
    pvW: number | null;
    state: string | null;
  } | null;
  // What the estimator said for `t` without this reading, computed once the
  // Victron read had merged the day's charger current in; null when it could
  // not (see `estimateReason`).
  estimateAtT: number | null;
  // Why `estimateAtT` is null: "stale-trends" (the open ended or the Victron read
  // failed before the trends were refreshed — a prediction from the stale cache
  // would be misleading), "no-estimate" (nothing to anchor or integrate from).
  estimateReason?: string | null;
}

// A follow-up line: the live prediction for the reading taken at `t`, written
// when the Victron read completes (the open's first line has `stale-trends`).
export interface EstimateUpdateEntry {
  t: number; // the reading's t
  estimateUpdate: { estimateAtT: number | null; reason?: string | null };
}

// null when there is no battery reading (nothing exact to log).
export function captureLogEntry(
  reading: VanReading,
  estimateAtT: number | null,
): CaptureLogEntry | null {
  const { battery, solar } = reading;
  if (!battery) return null;
  return {
    t: reading.readAt,
    ective: {
      soc: battery.soc,
      currentA: battery.currentA,
      voltageV: battery.cellSumV ?? battery.packVoltageV ?? null,
      capacityAh: battery.capacityAh,
      tempC: battery.tempC,
    },
    victron: solar
      ? {
          chargeA: solar.chargeA,
          batteryV: solar.batteryV,
          pvW: solar.solarW,
          state: solar.stateLabel,
        }
      : null,
    ...estimateFields(
      estimateAtT,
      estimateAtT === null ? "stale-trends" : null,
    ),
  };
}

function estimateFields(
  estimateAtT: number | null,
  reason: string | null,
): { estimateAtT: number | null; estimateReason: string | null } {
  const ok = estimateAtT !== null && Number.isFinite(estimateAtT);
  return {
    estimateAtT: ok ? Math.round(estimateAtT * 10) / 10 : null,
    estimateReason: ok ? null : (reason ?? "no-estimate"),
  };
}

export function estimateUpdateEntry(
  t: number,
  estimateAtT: number | null,
): EstimateUpdateEntry {
  const f = estimateFields(estimateAtT, "no-estimate");
  return {
    t,
    estimateUpdate: { estimateAtT: f.estimateAtT, reason: f.estimateReason },
  };
}

// The readings, each with its live prediction: a later `estimateUpdate` line for
// the same `t` replaces the open's provisional `stale-trends`.
export function parseCaptureLog(text: string): CaptureLogEntry[] {
  const lines = parseLines(text);
  const updates = new Map<number, EstimateUpdateEntry["estimateUpdate"]>();
  for (const value of lines) {
    const u = value as Partial<EstimateUpdateEntry>;
    if (typeof u?.t === "number" && u.estimateUpdate) {
      updates.set(u.t, u.estimateUpdate);
    }
  }
  return lines.flatMap((value) => {
    const e = value as Partial<CaptureLogEntry>;
    if (typeof e?.t !== "number" || typeof e.ective?.soc !== "number")
      return [];
    const update = updates.get(e.t);
    return [
      update
        ? {
            ...(e as CaptureLogEntry),
            estimateAtT: update.estimateAtT,
            estimateReason: update.reason ?? null,
          }
        : (e as CaptureLogEntry),
    ];
  });
}

// ─── Victron read attempts (so a missing trend sample can be explained) ─────

export interface VictronReadLogEntry {
  t: number; // when this phase happened
  victronRead: {
    phase: "start" | "done" | "failed";
    sinceMs?: number | null; // the incremental start (null: the whole 72 h)
    history?: boolean; // whether the daily history was requested
    ms?: number; // how long the session took (done / failed)
    newSamples?: number; // charger-current samples the read added (done)
    historyDays?: number; // daily records the read returned (done)
    errors?: string[]; // helper error codes, even on a partial success
    reason?: string; // why it failed
  };
}

export function parseVictronReadLog(text: string): VictronReadLogEntry[] {
  return parseLines(text).flatMap((value) => {
    const e = value as Partial<VictronReadLogEntry>;
    return typeof e?.t === "number" && typeof e.victronRead?.phase === "string"
      ? [e as VictronReadLogEntry]
      : [];
  });
}

export interface VictronReadSummary {
  t: number;
  sinceMs: number | null;
  history: boolean;
  outcome: "done" | "failed" | "cut short";
  ms: number | null;
  newSamples: number | null;
  historyDays: number | null;
  detail: string; // the reason, the helper's errors, or why it never finished
}

// Pairs every "start" with the "done"/"failed" that followed it. A start with
// no end before the next start (or the end of the file) never finished: the
// view was closed — Tinycast kills a closed view's JS — or it is still running.
export function summariseVictronReads(
  entries: VictronReadLogEntry[],
): VictronReadSummary[] {
  const rows: VictronReadSummary[] = [];
  let open: VictronReadLogEntry | null = null;
  const flush = (end: VictronReadLogEntry | null) => {
    if (!open) return;
    const r = end?.victronRead;
    rows.push({
      t: open.t,
      sinceMs: open.victronRead.sinceMs ?? null,
      history: open.victronRead.history ?? false,
      outcome: r ? (r.phase === "done" ? "done" : "failed") : "cut short",
      ms: r?.ms ?? null,
      newSamples: r?.newSamples ?? null,
      historyDays: r?.historyDays ?? null,
      detail: r
        ? (r.reason ?? (r.errors?.length ? r.errors.join(", ") : ""))
        : "no result logged — the view closed mid-read, or it is still running",
    });
    open = null;
  };
  for (const e of entries) {
    if (e.victronRead.phase === "start") {
      flush(null);
      open = e;
    } else {
      flush(e);
    }
  }
  flush(null);
  return rows;
}

// ─── The trends log ─────────────────────────────────────────────────────────

type Pair = [t: number, v: number | null];

export interface TrendsLogLine {
  readAt: number;
  A: Pair[]; // battery current (charger output), A
  V: Pair[]; // battery voltage, V
  W: Pair[]; // PV power, W
}

const VREG_OF = { A: 0xed8f, V: 0xed8d, W: 0xec8a } as const;

// The samples of one Victron read, as a compact line. Null when there are none.
export function trendsLogLine(
  trends: VictronTrends | null,
  readAt: number,
): TrendsLogLine | null {
  if (!trends) return null;
  const pairs = (vreg: number): Pair[] =>
    (trends.trends.find((t) => t.vreg === vreg)?.samples ?? []).map((s) => [
      s.t,
      s.v,
    ]);
  const line = {
    readAt,
    A: pairs(VREG_OF.A),
    V: pairs(VREG_OF.V),
    W: pairs(VREG_OF.W),
  };
  return line.A.length + line.V.length + line.W.length > 0 ? line : null;
}

// Every line merged into one series per vreg, oldest first. Samples of one
// device slot arrive in different reads with a few ms of jitter, so they are
// deduplicated by the minute (a later read wins).
export function parseTrendsLog(text: string): VictronTrends | null {
  const lines = parseLines(text)
    .filter(
      (l): l is TrendsLogLine =>
        typeof (l as TrendsLogLine)?.readAt === "number",
    )
    .sort((a, b) => a.readAt - b.readAt);
  if (lines.length === 0) return null;
  const merged = (key: "A" | "V" | "W") => {
    const byMinute = new Map<number, Pair>();
    for (const line of lines) {
      for (const pair of line[key] ?? []) {
        byMinute.set(Math.round(pair[0] / 60_000), pair);
      }
    }
    return [...byMinute.values()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => ({ t, v }));
  };
  const trends = (["A", "V", "W"] as const).flatMap((key) => {
    const samples = merged(key);
    return samples.length > 0
      ? [{ vreg: VREG_OF[key], segments: [], samples }]
      : [];
  });
  return trends.length > 0
    ? { anchor: { timeRef: 0, unixMs: lines.at(-1)!.readAt }, trends }
    : null;
}

// ─── fs glue ────────────────────────────────────────────────────────────────

function parseLines(text: string): unknown[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return []; // a torn last line must not hide the rest
    }
  });
}

// Appends one JSON line; once the file has outgrown `trimBytes`, rewrites it
// keeping only the lines `keep` accepts. Never throws.
function appendJsonLine(opts: {
  path: string;
  value: unknown;
  trimBytes: number;
  keep: (line: unknown) => boolean;
}): void {
  const { path, value, trimBytes, keep } = opts;
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size > trimBytes) {
      const kept = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => {
          if (!line.trim()) return false;
          try {
            return keep(JSON.parse(line));
          } catch {
            return false;
          }
        });
      writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    }
    appendFileSync(path, `${JSON.stringify(value)}\n`);
  } catch {
    // Deliberately swallowed — see the header.
  }
}

export function appendCaptureLog(opts: {
  path: string;
  entry: CaptureLogEntry;
  now?: number;
}): void {
  const cutoff = (opts.now ?? Date.now()) - CAPTURE_LOG_KEEP_MS;
  appendJsonLine({
    path: opts.path,
    value: opts.entry,
    trimBytes: CAPTURE_LOG_TRIM_BYTES,
    keep: (line) => ((line as CaptureLogEntry)?.t ?? 0) >= cutoff,
  });
}

export function appendEstimateUpdate(opts: {
  path: string;
  entry: EstimateUpdateEntry;
}): void {
  const cutoff = opts.entry.t - CAPTURE_LOG_KEEP_MS;
  appendJsonLine({
    path: opts.path,
    value: opts.entry,
    trimBytes: CAPTURE_LOG_TRIM_BYTES,
    keep: (line) => ((line as { t?: number })?.t ?? 0) >= cutoff,
  });
}

// One line in van-log.jsonl about a Victron read (same file, same 60 days).
export function appendVictronReadLog(opts: {
  path: string;
  entry: VictronReadLogEntry;
}): void {
  const cutoff = opts.entry.t - CAPTURE_LOG_KEEP_MS;
  appendJsonLine({
    path: opts.path,
    value: opts.entry,
    trimBytes: CAPTURE_LOG_TRIM_BYTES,
    keep: (line) => ((line as { t?: number })?.t ?? 0) >= cutoff,
  });
}

export function appendTrendsLog(opts: {
  path: string;
  line: TrendsLogLine;
  now?: number;
}): void {
  const cutoff = (opts.now ?? Date.now()) - TRENDS_LOG_KEEP_MS;
  const newest = (l: unknown): number => {
    const line = l as TrendsLogLine;
    return Math.max(
      ...[line?.A, line?.V, line?.W].flatMap((pairs) =>
        (pairs ?? []).map((p) => p[0]),
      ),
      0,
    );
  };
  appendJsonLine({
    path: opts.path,
    value: opts.line,
    trimBytes: TRENDS_LOG_TRIM_BYTES,
    keep: (line) => newest(line) >= cutoff,
  });
}

export function readTextFile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}
