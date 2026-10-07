// Battery charge (%) over the last 72 h, estimated by **coulomb counting
// anchored to the exact readings the Ective BMS gave us**.
//
// Voltage is a poor SoC gauge for LiFePO4 (the curve is flat from ~20 % to ~90 %
// and sags/rises with current), so voltage is *not* mapped to a percentage here.
// Instead the charge is integrated from what flows into and out of the pack:
//
//   dSoC/dt = (charger current(t) − L) / capacity
//
// where the charger current is the Victron's own battery-current trend (0xED8F,
// ≥ 0 into the pack; 0 while it sleeps at night) and L is the house load.
//
// **L is derived from the energy balance between two anchors, never from an
// instantaneous current** (the BMS's current at the moment of a reading is
// whatever happened to be switched on — a laptop, a power bank — not the average
// load that drained the pack overnight):
//
//   L_i = (∫ charger current dt − ΔSoC · capacity / 100) / Δt        (≥ 0)
//
// over each interval between consecutive anchors, used inside that interval (so
// the curve hits both anchors by construction). Before the first / after the last
// anchor the nearest reliable interval's L carries on; with no reliable interval
// the instantaneous-current median is the fallback, then 0.6 A.
//
//   - Anchors: every reading (exact %) and every confirmed "full" (see below).
//   - A leftover (L clamped at 0, or the integration clamped at 0/100) is spread
//     linearly in time, so the curve always hits both anchors exactly.
//   - Full re-sync: the charger in absorption/float (voltage ≥ 13.9 V, awake, the
//     charge current tapered below 0.03 C) means the pack is physically full —
//     pinned to 100 % for as long as that lasts, and an anchor at its ends.
//   - Everything is clamped to 0–100.
//
// Pure, no dependencies; unit-tested.

import type { VictronTrends } from "./victron-trends";

export interface SocCapture {
  t: number; // epoch ms
  soc: number; // measured %, exact
  netA?: number | null; // the BMS's net battery current at that moment (+ charging)
}

export interface SocPoint {
  t: number;
  soc: number; // 0–100
  kind: "measured" | "estimated";
}

// ─── Constants (assumptions, kept in one place) ─────────────────────────────

export const DEFAULT_CAPACITY_AH = 100; // when the BMS capacity is unknown
export const DEFAULT_LOAD_A = 0.6; // when no reading carries both currents
export const FULL_VOLTS = 13.9; // charger in absorption (this pack's is ~14.2–14.4)
export const FULL_TAPER_C = 0.03; // charge current below this × capacity: tapered
const AWAKE_W = 1; // PV power above this: the charger is running
const AWAKE_A = 0.05;
const GRID_MS = 10 * 60_000;
const NEAR_SAMPLE_MS = 40 * 60_000; // a trend sample further away than this is "no data"
const MIN_INTERVAL_MS = 2 * 3_600_000; // shorter spans are too noisy to infer a load from
const RECENT_INTERVALS_MS = 3 * 24 * 3_600_000; // the loads a prediction beyond the anchors is based on
const CAPTURE_PRECEDENCE_MS = 2 * 3_600_000; // a full-anchor this close to a reading yields to it
const MAX_STEP_MS = 3 * GRID_MS; // a longer hole in the output is a gap, not a line

// What `make van-eval` prints next to its error table — the knobs to tune.
export const ESTIMATOR_CONSTANTS = {
  DEFAULT_CAPACITY_AH,
  DEFAULT_LOAD_A,
  FULL_VOLTS,
  FULL_TAPER_C,
  AWAKE_W,
  AWAKE_A,
  GRID_MS,
  NEAR_SAMPLE_MS,
  MIN_INTERVAL_H: MIN_INTERVAL_MS / 3_600_000,
  RECENT_INTERVALS_DAYS: RECENT_INTERVALS_MS / 86_400_000,
  CAPTURE_PRECEDENCE_MS,
} as const;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

// ─── Trend access ───────────────────────────────────────────────────────────

export const VREG = {
  pvW: 0xec8a,
  batteryV: 0xed8d,
  batteryA: 0xed8f,
  pvV: 0xedbb,
} as const;

type Series = ReadonlyArray<{ t: number; v: number }>;

export function seriesOf(trends: VictronTrends | null, vreg: number): Series {
  const trend = trends?.trends.find((t) => t.vreg === vreg);
  return (trend?.samples ?? []).flatMap((s) =>
    s.v === null ? [] : [{ t: s.t, v: s.v }],
  );
}

// Linear interpolation inside the series; null when no sample is within
// NEAR_SAMPLE_MS (a hole in the data).
export function valueAt(series: Series, t: number): number | null {
  if (series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  if (t <= a.t) return a.t - t <= NEAR_SAMPLE_MS ? a.v : null;
  if (t >= b.t) return t - b.t <= NEAR_SAMPLE_MS ? b.v : null;
  if (b.t - a.t > 2 * NEAR_SAMPLE_MS) {
    if (t - a.t <= NEAR_SAMPLE_MS) return a.v;
    if (b.t - t <= NEAR_SAMPLE_MS) return b.v;
    return null;
  }
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

// ─── House load ─────────────────────────────────────────────────────────────

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The fallback load in amps: median over the readings of (charger current at
// the reading − the BMS's instantaneous net current at the reading), at least 0.
// Only used when no interval between anchors is long enough to infer a load
// from — an instantaneous current is a poor proxy for the average load.
export function estimateLoadA(opts: {
  trends: VictronTrends | null;
  captures: SocCapture[];
}): number {
  const charge = seriesOf(opts.trends, VREG.batteryA);
  const votes = opts.captures.flatMap((c) => {
    if (c.netA === null || c.netA === undefined || !Number.isFinite(c.netA))
      return [];
    const a = valueAt(charge, c.t);
    return a === null ? [] : [Math.max(0, a - c.netA)];
  });
  return votes.length > 0 ? median(votes) : DEFAULT_LOAD_A;
}

// ─── Full detection ─────────────────────────────────────────────────────────

export interface Run {
  from: number;
  to: number;
}

// Stretches where the charger reports a full pack: voltage in absorption, the
// charger awake (a sleeping charger holds its last voltage for hours — that is
// not a full pack) and the charge current tapered.
export function confirmedFullRuns(
  trends: VictronTrends | null,
  capacityAh: number,
): Run[] {
  const volts = seriesOf(trends, VREG.batteryV);
  const charge = seriesOf(trends, VREG.batteryA);
  const pvW = seriesOf(trends, VREG.pvW);
  const taper = FULL_TAPER_C * capacityAh;
  const runs: Run[] = [];
  let open: Run | null = null;
  for (const sample of volts) {
    const a = valueAt(charge, sample.t);
    const w = valueAt(pvW, sample.t);
    const awake = (w !== null && w > AWAKE_W) || (a !== null && a > AWAKE_A);
    const full = sample.v >= FULL_VOLTS && awake && (a ?? 0) < taper;
    if (full && open && sample.t - open.to <= NEAR_SAMPLE_MS)
      open.to = sample.t;
    else if (full) {
      open = { from: sample.t, to: sample.t };
      runs.push(open);
    } else open = null;
  }
  return runs;
}

// ─── The estimate ───────────────────────────────────────────────────────────

export interface Anchor {
  t: number;
  soc: number;
  kind: "capture" | "full";
}

// Every reading, and the ends of each full run unless a reading is close by
// (the reading is the better witness).
function buildAnchors(
  captures: { t: number; soc: number }[],
  runs: Run[],
  from: number,
  to: number,
): Anchor[] {
  const anchors: Anchor[] = captures.map((c) => ({
    t: c.t,
    soc: c.soc,
    kind: "capture",
  }));
  for (const run of runs) {
    for (const t of [run.from, run.to]) {
      if (t < from || t > to) continue;
      if (captures.some((c) => Math.abs(c.t - t) < CAPTURE_PRECEDENCE_MS))
        continue;
      anchors.push({ t, soc: 100, kind: "full" });
    }
  }
  return anchors.sort((a, b) => a.t - b.t);
}

// One stretch between two consecutive anchors and the load it implies.
export interface IntervalLoad {
  from: number;
  to: number;
  hours: number;
  fromKind: Anchor["kind"];
  toKind: Anchor["kind"];
  fromSoc: number;
  toSoc: number;
  chargeAh: number; // what the charger put in
  loadA: number; // implied average load, ≥ 0
  reliable: boolean; // long enough to trust (and not the inside of one full run)
}

const chargeBetween = (charge: Series, from: number, to: number): number => {
  let ah = 0;
  for (let t = from; t < to; t += 5 * 60_000) {
    const dt = Math.min(5 * 60_000, to - t);
    ah += (valueAt(charge, t + dt / 2) ?? 0) * (dt / 3_600_000);
  }
  return ah;
};

function intervalsBetween(
  anchors: Anchor[],
  charge: Series,
  runs: Run[],
  capacityAh: number,
): IntervalLoad[] {
  const out: IntervalLoad[] = [];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const a = anchors[k];
    const b = anchors[k + 1];
    const hours = (b.t - a.t) / 3_600_000;
    const chargeAh = chargeBetween(charge, a.t, b.t);
    const insideFull = runs.some((r) => a.t >= r.from && b.t <= r.to);
    out.push({
      from: a.t,
      to: b.t,
      hours,
      fromKind: a.kind,
      toKind: b.kind,
      fromSoc: a.soc,
      toSoc: b.soc,
      chargeAh,
      loadA:
        hours > 0
          ? Math.max(
              0,
              (chargeAh - ((b.soc - a.soc) * capacityAh) / 100) / hours,
            )
          : 0, // two anchors at the same instant imply nothing
      reliable: b.t - a.t >= MIN_INTERVAL_MS && !insideFull,
    });
  }
  return out;
}

// The loads implied between every pair of consecutive anchors (readings and
// confirmed fulls) — the table `make van-eval` prints.
export function intervalLoads(opts: {
  trends: VictronTrends | null;
  captures: SocCapture[];
  from: number;
  to: number;
  capacityAh?: number | null;
}): IntervalLoad[] {
  const capacityAh =
    opts.capacityAh && opts.capacityAh > 0
      ? opts.capacityAh
      : DEFAULT_CAPACITY_AH;
  const captures = opts.captures
    .filter((c) => c.t >= opts.from && c.t <= opts.to && Number.isFinite(c.soc))
    .map((c) => ({ t: c.t, soc: clamp(c.soc, 0, 100) }))
    .sort((a, b) => a.t - b.t);
  const runs = confirmedFullRuns(opts.trends, capacityAh).filter(
    (r) => r.to >= opts.from && r.from <= opts.to,
  );
  return intervalsBetween(
    buildAnchors(captures, runs, opts.from, opts.to),
    seriesOf(opts.trends, VREG.batteryA),
    runs,
    capacityAh,
  );
}

// Output is time-sorted: a point every 10 minutes (kind "estimated") plus every
// reading inside the window at its exact value (kind "measured"). Nothing can
// be integrated without a charger-current trend, and nothing anchored without
// a reading or a confirmed full: then only the readings come back.
export function estimateSoc(opts: {
  trends: VictronTrends | null;
  captures: SocCapture[];
  from: number;
  to: number;
  capacityAh?: number | null;
}): SocPoint[] {
  const { trends, from, to } = opts;
  const capacityAh =
    opts.capacityAh && opts.capacityAh > 0
      ? opts.capacityAh
      : DEFAULT_CAPACITY_AH;
  const captures = opts.captures
    .filter((c) => c.t >= from && c.t <= to && Number.isFinite(c.soc))
    .map((c) => ({ ...c, soc: clamp(c.soc, 0, 100) }))
    .sort((a, b) => a.t - b.t);
  const measured: SocPoint[] = captures.map((c) => ({
    t: c.t,
    soc: c.soc,
    kind: "measured",
  }));

  const charge = seriesOf(trends, VREG.batteryA);
  if (charge.length === 0) return measured;

  const runs = confirmedFullRuns(trends, capacityAh).filter(
    (r) => r.to >= from && r.from <= to,
  );
  const anchors = buildAnchors(captures, runs, from, to);
  if (anchors.length === 0) return measured;

  // The load of each interval between anchors, from the energy balance. What
  // carries on beyond the anchors (and stands in for the short or unreliable
  // intervals) is the median of ALL reliable intervals of the last ~3 days — not
  // the nearest one: a quiet evening (0.5 A) must not predict the whole next
  // night. With no reliable interval the instantaneous-current median (then
  // 0.6 A) stands in.
  const intervals = intervalsBetween(anchors, charge, runs, capacityAh);
  const reliable = intervals.filter((i) => i.reliable);
  const recent = reliable.filter((i) => i.to >= to - RECENT_INTERVALS_MS);
  const typicalA = (recent.length ? recent : reliable).length
    ? median((recent.length ? recent : reliable).map((i) => i.loadA))
    : estimateLoadA({ trends, captures: opts.captures });
  const loadOf = (i: IntervalLoad): number => (i.reliable ? i.loadA : typicalA);
  const loadBefore = typicalA;
  const loadAfter = typicalA;

  // Nodes: the 10-minute grid and the anchor times.
  const nodes = [
    ...new Set([
      ...Array.from(
        {
          length:
            Math.floor((to - Math.ceil(from / GRID_MS) * GRID_MS) / GRID_MS) +
            1,
        },
        (_, i) => Math.ceil(from / GRID_MS) * GRID_MS + i * GRID_MS,
      ),
      ...anchors.map((a) => a.t),
    ]),
  ].sort((a, b) => a - b);

  const amps = nodes.map((t) => valueAt(charge, t) ?? 0);
  // The change in % from node i-1 to node i under a load of `loadA` (trapezoid).
  const step = (i: number, loadA: number): number =>
    ((((amps[i - 1] + amps[i]) / 2 - loadA) * (nodes[i] - nodes[i - 1])) /
      3_600_000 /
      capacityAh) *
    100;

  const indexOf = new Map(nodes.map((t, i) => [t, i]));
  const soc = new Array<number>(nodes.length).fill(NaN);

  const first = indexOf.get(anchors[0].t)!;
  soc[first] = anchors[0].soc;
  for (let i = first - 1; i >= 0; i--)
    soc[i] = clamp(soc[i + 1] - step(i + 1, loadBefore), 0, 100);

  for (let k = 0; k < anchors.length - 1; k++) {
    const ia = indexOf.get(anchors[k].t)!;
    const ib = indexOf.get(anchors[k + 1].t)!;
    const loadA = loadOf(intervals[k]);
    const free = new Array<number>(ib - ia + 1);
    free[0] = anchors[k].soc;
    for (let i = 1; i <= ib - ia; i++) {
      free[i] = clamp(free[i - 1] + step(ia + i, loadA), 0, 100);
    }
    // Zero with the interval's own load, unless it was clamped (L < 0 or the
    // integration hit 0 / 100): then the leftover is spread linearly.
    const drift = anchors[k + 1].soc - free[ib - ia];
    const span = nodes[ib] - nodes[ia];
    for (let i = 0; i <= ib - ia; i++) {
      const frac = span > 0 ? (nodes[ia + i] - nodes[ia]) / span : 0;
      soc[ia + i] = clamp(free[i] + drift * frac, 0, 100);
    }
  }

  const last = indexOf.get(anchors[anchors.length - 1].t)!;
  for (let i = last + 1; i < nodes.length; i++) {
    soc[i] = clamp(soc[i - 1] + step(i, loadAfter), 0, 100);
  }

  // A confirmed full pins the stretch it lasts to 100 %.
  nodes.forEach((t, i) => {
    if (runs.some((r) => t >= r.from && t <= r.to)) soc[i] = 100;
  });

  const estimated: SocPoint[] = nodes.flatMap((t, i) =>
    t < from || t > to || captures.some((c) => c.t === t)
      ? []
      : [{ t, soc: soc[i], kind: "estimated" as const }],
  );
  return [...estimated, ...measured].sort(
    (a, b) => a.t - b.t || (a.kind === "measured" ? 1 : -1),
  );
}

// What the estimator says for the single instant `t`, from the readings and
// trends known *before* it — the number a new reading is judged against. Null
// when there is nothing to estimate from (no charger-current trend, or no
// anchor yet).
export function estimateAt(opts: {
  trends: VictronTrends | null;
  captures: SocCapture[];
  t: number;
  capacityAh?: number | null;
}): number | null {
  const points = estimateSoc({
    trends: opts.trends,
    captures: opts.captures,
    from: opts.t - 72 * 3_600_000,
    to: opts.t,
    capacityAh: opts.capacityAh,
  }).filter((p) => p.kind === "estimated");
  const last = points.at(-1);
  return last && opts.t - last.t <= 2 * GRID_MS ? last.soc : null;
}

// The estimate as chart input: `null` between stretches more than a few grid
// steps apart, so the line breaks instead of bridging an unknown.
export function socSeries(points: SocPoint[]): {
  times: number[];
  values: Array<number | null>;
} {
  const times: number[] = [];
  const values: Array<number | null> = [];
  points.forEach((p, i) => {
    const prev = points[i - 1];
    if (prev && p.t - prev.t > MAX_STEP_MS) {
      times.push(prev.t + (p.t - prev.t) / 2);
      values.push(null);
    }
    times.push(p.t);
    values.push(p.soc);
  });
  return { times, values };
}
