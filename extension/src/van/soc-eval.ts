// Evaluation of the SoC estimator against the captures it was logged next to —
// the engine of `make van-eval` (scripts/van-eval.ts). Pure: it takes the parsed
// log and trends and returns numbers; the script reads the files and prints.
//
// Leave-one-out: for every logged Ective reading the estimator is run on all the
// OTHER readings and asked for that moment, so the error is what the user would
// have seen had the reading not been taken — the honest measure for tuning
// (an anchored estimate is trivially exact at its own anchors).

import { CaptureLogEntry } from "./capture-log";
import { Location, nightSpans } from "./sun";
import {
  ESTIMATOR_CONSTANTS,
  IntervalLoad,
  SocCapture,
  SocPoint,
  confirmedFullRuns,
  estimateLoadA,
  estimateSoc,
  intervalLoads,
} from "./soc-estimate";
import { VictronTrends } from "./victron-trends";

const HOUR = 3_600_000;

export interface EvalRow {
  t: number;
  measured: number;
  predicted: number | null; // leave-one-out
  error: number | null; // predicted − measured
  hoursToAnchor: number | null; // to the nearest OTHER reading or confirmed full
  night: boolean;
  logged: number | null; // what the app predicted at the time (estimateAtT)
  loggedNote: string | null; // why there is none ("stale-trends", "no-estimate")
  loggedError: number | null;
}

export interface EvalReport {
  rows: EvalRow[];
  summary: {
    n: number; // readings with a leave-one-out prediction
    mae: number | null;
    maxAbs: number | null;
    loggedN: number;
    loggedSkipped: number; // readings with no live prediction (stale trends / nothing to estimate)
    loggedSkippedReasons: Record<string, number>;
    loggedMae: number | null;
    loggedMaxAbs: number | null;
  };
  loadA: number; // the instantaneous-current fallback load (used only with no interval)
  intervals: IntervalLoad[]; // the load implied between every pair of consecutive anchors
  constants: Record<string, number>;
}

export const toCaptures = (entries: CaptureLogEntry[]): SocCapture[] =>
  entries.map((e) => ({
    t: e.t,
    soc: e.ective.soc,
    netA: e.ective.currentA,
  }));

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The estimate at `t` by linear interpolation between its grid neighbours (the
// held-out reading is not in the series, so there is no point exactly at `t`).
function predictAt(points: SocPoint[], t: number): number | null {
  const est = points.filter((p) => p.kind === "estimated");
  const after = est.findIndex((p) => p.t >= t);
  if (after <= 0) return null;
  const a = est[after - 1];
  const b = est[after];
  if (b.t - a.t > 30 * 60_000) return null; // a hole, not an estimate
  return a.soc + ((b.soc - a.soc) * (t - a.t)) / (b.t - a.t);
}

const mean = (values: number[]): number | null =>
  values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

export function evaluate(opts: {
  entries: CaptureLogEntry[];
  trends: VictronTrends | null;
  location: (t: number) => Location;
}): EvalReport {
  const { trends } = opts;
  const entries = [...opts.entries].sort((a, b) => a.t - b.t);
  const captures = toCaptures(entries);
  const capacityAh = entries.length
    ? median(entries.map((e) => e.ective.capacityAh))
    : ESTIMATOR_CONSTANTS.DEFAULT_CAPACITY_AH;
  const runs = confirmedFullRuns(trends, capacityAh);
  const fullTimes = runs.flatMap((r) => [r.from, r.to]);

  const from = (entries[0]?.t ?? 0) - 12 * HOUR;
  const to = (entries.at(-1)?.t ?? 0) + HOUR;

  const rows: EvalRow[] = entries.map((entry, i) => {
    // A prediction written before the live estimate waited for the Victron read
    // (no `estimateReason` at all) came from the stale cache — excluded.
    const legacy =
      entry.estimateReason === undefined && entry.estimateAtT !== null;
    const live = legacy ? null : entry.estimateAtT;
    const note = legacy ? "legacy" : (entry.estimateReason ?? "stale-trends");
    const others = captures.filter((_, k) => k !== i);
    const points = estimateSoc({
      trends,
      captures: others,
      from,
      to,
      capacityAh: entry.ective.capacityAh,
    });
    const predicted = predictAt(points, entry.t);
    const anchors = [...others.map((c) => c.t), ...fullTimes];
    const nearest = anchors.length
      ? Math.min(...anchors.map((t) => Math.abs(t - entry.t))) / HOUR
      : null;
    const spans = nightSpans({
      from: entry.t - HOUR,
      to: entry.t + HOUR,
      location: opts.location(entry.t),
    });
    return {
      t: entry.t,
      measured: entry.ective.soc,
      predicted,
      error: predicted === null ? null : predicted - entry.ective.soc,
      hoursToAnchor: nearest,
      night: spans.some((s) => entry.t >= s.from && entry.t <= s.to),
      logged: live,
      loggedNote: live === null ? note : null,
      loggedError: live === null ? null : live - entry.ective.soc,
    };
  });

  const errors = rows.flatMap((r) =>
    r.error === null ? [] : [Math.abs(r.error)],
  );
  const logged = rows.flatMap((r) =>
    r.loggedError === null ? [] : [Math.abs(r.loggedError)],
  );
  return {
    rows,
    summary: {
      n: errors.length,
      mae: mean(errors),
      maxAbs: errors.length ? Math.max(...errors) : null,
      loggedN: logged.length,
      loggedSkipped: rows.filter((r) => r.logged === null).length,
      loggedSkippedReasons: rows.reduce<Record<string, number>>((acc, r) => {
        if (r.loggedNote) acc[r.loggedNote] = (acc[r.loggedNote] ?? 0) + 1;
        return acc;
      }, {}),
      loggedMae: mean(logged),
      loggedMaxAbs: logged.length ? Math.max(...logged) : null,
    },
    loadA: estimateLoadA({ trends, captures }),
    intervals: intervalLoads({ trends, captures, from, to, capacityAh }),
    constants: { ...ESTIMATOR_CONSTANTS },
  };
}
