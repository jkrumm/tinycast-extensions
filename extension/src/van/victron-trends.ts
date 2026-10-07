// Pure decoding of the SmartSolar's stored trends (30-minute samples, 45 days,
// held in the BLE module), as captured by `van-ble --victron-trends` — no
// @raycast/api import, so it runs under vitest. The helper is transport only
// (raw register payloads as hex); every field is decoded here.
//
// Protocol (from VictronConnect 6.43's shared `vregs.json` and its TrendsManager,
// then verified live against a SmartSolar): 0xEC5D lists the trend vregs, one per
// trend index. A trend has 4 cascading subtrends (config 0xEC4A+index: byte 0
// subtrend count, byte 1 max samples per push, then u16 sample-count / u16 step
// pairs); subtrend 3 is the 30-minute store, 2160 samples. The push request
// (setValues on 0xEC5B) answers with `[u8 trend][u32 ref][u8 n][u16 step][n
// samples]`, little-endian, samples NEWEST first: sample i was taken at
// `ref − i·step`, and `ref` is the request aligned up to the step grid.
// A subtrend holds what the previous one has aged out: subtrend 3 (30 min) ends
// about a day before now, 2 (5 min) covers roughly 2–26 h ago, 1 (30 s) the last
// ~2 h (each one's newest ref is 0xEC52+index, u32 per subtrend). The helper
// fetches all three; `decodeTrends` stitches them into one 72 h series.

import { hexToBytes } from "./parse";
import { VictronHistory, parseHistoryOutput } from "./victron-history";

export const TREND_WINDOW_MS = 72 * 3600 * 1000;
const COARSE_STEP_S = 300; // finer subtrends are averaged down to this

interface TrendKind {
  bytes: 1 | 2;
  signed: boolean;
  scale: number;
  invalid: number; // raw value meaning "not available"
}

// vregs.json: EC89 un8 0.1 A (output current), EDBB un16 0.01 V (PV voltage),
// EC8A un16 W (PV power), EC88 sn8 °C (battery temperature), ED8D sn16 0.01 V
// (battery voltage), ED8F sn16 0.1 A (battery current), EC87 un8 % (SOC).
const KINDS: Record<number, TrendKind> = {
  0xec89: { bytes: 1, signed: false, scale: 10, invalid: 0xff },
  0xedbb: { bytes: 2, signed: false, scale: 100, invalid: 0xffff },
  0xec8a: { bytes: 2, signed: false, scale: 1, invalid: 0xffff },
  0xec88: { bytes: 1, signed: true, scale: 1, invalid: 0x7f },
  0xed8d: { bytes: 2, signed: true, scale: 100, invalid: 0x7fff },
  0xed8f: { bytes: 2, signed: true, scale: 10, invalid: 0x7fff },
  0xec87: { bytes: 1, signed: false, scale: 1, invalid: 0xff },
};

export interface TrendSample {
  t: number; // unix ms
  v: number | null; // scaled; null = the device marked it invalid / not available
}

// A run of consecutive samples at one native step (1800 s, then 300 s).
export interface TrendSegment {
  stepS: number;
  fromMs: number;
  toMs: number;
  count: number;
}

export interface VictronTrend {
  vreg: number;
  segments: TrendSegment[]; // oldest first
  samples: TrendSample[]; // time-sorted, oldest first, within the last 72 h
}

export interface VictronTrends {
  // The device's clock reading (0xEC5A, counts seconds) paired with the Mac's
  // clock at the moment the reply arrived. Sample times are anchored here — the
  // device's own time tuple (0xEC5F) is not used, it drifts by days.
  anchor: { timeRef: number; unixMs: number };
  trends: VictronTrend[];
}

export interface VictronTrendsResult {
  trends: VictronTrends | null;
  errors: string[]; // helper error codes, e.g. victron-trend-reply-timeout:4:30065100
}

interface RawTrends {
  anchor: { timeRef: number; unixMs: number };
  supportedHex: string;
  pushes: { trend: number; replies?: string[] }[];
}

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function rawValue(b: Uint8Array, offset: number, kind: TrendKind): number {
  if (kind.bytes === 1) {
    const v = b[offset];
    return kind.signed && v > 0x7f ? v - 0x100 : v;
  }
  const v = u16(b, offset);
  return kind.signed && v > 0x7fff ? v - 0x10000 : v;
}

interface Point {
  ref: number;
  v: number | null;
  stepS: number;
}

// Averages 30 s samples into 5-minute buckets labelled by their end ref (the
// device's own "aligned up" convention). An incomplete bucket is dropped
// unless it is the newest one, which has no coarser counterpart to prefer.
function downsample(
  points: Map<number, number | null>,
  stepS: number,
): Point[] {
  const per = COARSE_STEP_S / stepS;
  const buckets = new Map<number, (number | null)[]>();
  for (const [ref, v] of points) {
    const end = Math.ceil(ref / COARSE_STEP_S) * COARSE_STEP_S;
    buckets.set(end, [...(buckets.get(end) ?? []), v]);
  }
  const newest = Math.max(...buckets.keys());
  const out: Point[] = [];
  for (const [ref, values] of [...buckets.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    if (values.length < per && ref !== newest) continue;
    const valid = values.filter((v): v is number => v !== null);
    out.push({
      ref,
      v: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
      stepS: COARSE_STEP_S,
    });
  }
  return out;
}

// Decodes the raw capture into one stitched series per trend. Replies carry
// their own step, so the subtrend they came from is known without bookkeeping:
// 30 s is averaged to 5 min, then the finest data wins where series overlap
// (a coarser sample is kept only if it is older than everything finer). A
// malformed reply is skipped and its trend simply has fewer samples.
export function decodeTrends(raw: RawTrends): VictronTrends | null {
  const supported = hexToBytes(raw.supportedHex);
  if (!supported || supported.length !== 16) return null;
  const { anchor } = raw;
  const windowStartRef = anchor.timeRef - TREND_WINDOW_MS / 1000;

  const trends: VictronTrend[] = [];
  for (let index = 0; index < 8; index++) {
    const vreg = u16(supported, index * 2);
    if (vreg === 0xffff || vreg === 0) break;
    const kind = KINDS[vreg];
    if (!kind) continue;

    const byStep = new Map<number, Map<number, number | null>>();
    for (const push of raw.pushes) {
      for (const hex of push.replies ?? []) {
        const b = hexToBytes(hex);
        if (!b || b.length < 8 || b[0] !== index) continue;
        const count = b[5];
        const stepS = u16(b, 6);
        if (stepS === 0 || b.length !== 8 + count * kind.bytes) continue;
        const ref = u32(b, 1);
        const points = byStep.get(stepS) ?? new Map<number, number | null>();
        for (let i = 0; i < count; i++) {
          const value = rawValue(b, 8 + i * kind.bytes, kind);
          points.set(
            ref - i * stepS,
            value === kind.invalid ? null : value / kind.scale,
          );
        }
        byStep.set(stepS, points);
      }
    }

    // Finest first; steps below 5 min are averaged to 5 min.
    const series = [...byStep.entries()]
      .sort(([a], [b]) => a - b)
      .map(([stepS, points]): Point[] =>
        stepS < COARSE_STEP_S
          ? downsample(points, stepS)
          : [...points.entries()].map(([ref, v]) => ({ ref, v, stepS })),
      );
    const merged: Point[] = [];
    let finestStart = Infinity;
    for (const points of series) {
      for (const point of points) {
        if (point.ref < finestStart) merged.push(point);
      }
      finestStart = Math.min(finestStart, ...points.map((p) => p.ref));
    }
    const kept = merged
      .filter((p) => p.ref >= windowStartRef)
      .sort((a, b) => a.ref - b.ref);
    if (kept.length === 0) continue;

    const samples = kept.map((p) => ({
      t: anchor.unixMs - (anchor.timeRef - p.ref) * 1000,
      v: p.v,
    }));
    const segments: TrendSegment[] = [];
    kept.forEach((p, i) => {
      const last = segments.at(-1);
      if (last && last.stepS === p.stepS) {
        last.toMs = samples[i].t;
        last.count++;
      } else {
        segments.push({
          stepS: p.stepS,
          fromMs: samples[i].t,
          toMs: samples[i].t,
          count: 1,
        });
      }
    });
    trends.push({ vreg, segments, samples });
  }
  return trends.length > 0 ? { anchor, trends } : null;
}

// The helper's last stdout line → decoded trends. Throws on output that is not
// the contract; a device-side failure is `errors` with `trends: null`.
export function parseTrendsOutput(json: string): VictronTrendsResult {
  const line = json
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) throw new Error("van-ble printed nothing");
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("van-ble output is not an object");
  }
  const out = parsed as {
    victronTrendsRaw?: RawTrends | null;
    errors?: unknown;
  };
  if (!("victronTrendsRaw" in out) || !Array.isArray(out.errors)) {
    throw new Error("van-ble output misses victronTrendsRaw / errors");
  }
  const errors = out.errors.filter((e): e is string => typeof e === "string");
  return {
    trends: out.victronTrendsRaw ? decodeTrends(out.victronTrendsRaw) : null,
    errors,
  };
}

export interface VictronAllResult {
  history: VictronHistory;
  trends: VictronTrends | null;
  errors: string[];
}

// `van-ble --victron-all`: one line carrying the daily history and the raw
// trends. Either part may be missing without losing the other — the helper
// reports a failed part as null (history: `total: null, days: []`) plus an
// error code, and the other part is still decoded.
export function parseAllOutput(
  json: string,
  now: Date | number = Date.now(),
): VictronAllResult {
  const { trends, errors } = parseTrendsOutput(json);
  return { history: parseHistoryOutput(json, now), trends, errors };
}

// ─── Incremental refresh ─────────────────────────────────────────────────────

const stepAt = (trend: VictronTrend, t: number): number =>
  (trend.segments.find((s) => t >= s.fromMs && t <= s.toMs) ??
    trend.segments.at(-1))!.stepS;

function segmentsOf(
  samples: (TrendSample & { stepS: number })[],
): TrendSegment[] {
  const segments: TrendSegment[] = [];
  for (const s of samples) {
    const last = segments.at(-1);
    if (last && last.stepS === s.stepS) {
      last.toMs = s.t;
      last.count++;
    } else {
      segments.push({ stepS: s.stepS, fromMs: s.t, toMs: s.t, count: 1 });
    }
  }
  return segments;
}

// Merges a cached series with a fresh (usually incremental) one, per vreg.
// Samples of one device grid slot come out of different runs with a few ms of
// anchor jitter, so two samples are the same slot when they are closer than half
// the finer step; then the finer one wins, and on a tie the fresh one (a newer
// run completes the cached run's still-filling newest bucket). Everything else
// is kept: a gap between cached and fresh stays a gap. The result is time-sorted
// and trimmed to the 72 h before `nowMs`; the anchor is the fresh one.
export function mergeTrends(
  cached: VictronTrends | null,
  fresh: VictronTrends | null,
  nowMs: number,
): VictronTrends | null {
  if (!cached && !fresh) return null;
  const vregs = [
    ...new Set(
      [...(cached?.trends ?? []), ...(fresh?.trends ?? [])].map((t) => t.vreg),
    ),
  ];
  const cutoff = nowMs - TREND_WINDOW_MS;

  const trends: VictronTrend[] = [];
  for (const vreg of vregs) {
    const items: (TrendSample & { stepS: number; fresh: boolean })[] = [];
    for (const [source, isFresh] of [
      [cached, false],
      [fresh, true],
    ] as const) {
      const trend = source?.trends.find((t) => t.vreg === vreg);
      for (const s of trend?.samples ?? []) {
        if (s.t >= cutoff)
          items.push({ ...s, stepS: stepAt(trend!, s.t), fresh: isFresh });
      }
    }
    items.sort((a, b) => a.t - b.t);

    const kept: typeof items = [];
    for (const item of items) {
      const last = kept.at(-1);
      if (
        !last ||
        item.t - last.t >= (Math.min(item.stepS, last.stepS) * 1000) / 2
      ) {
        kept.push(item);
        continue;
      }
      const better =
        item.stepS < last.stepS ||
        (item.stepS === last.stepS && item.fresh && !last.fresh);
      if (better) kept[kept.length - 1] = item;
    }
    if (kept.length === 0) continue;
    trends.push({
      vreg,
      segments: segmentsOf(kept),
      samples: kept.map(({ t, v }) => ({ t, v })),
    });
  }
  const anchor = fresh?.anchor ?? cached?.anchor;
  return trends.length > 0 && anchor ? { anchor, trends } : null;
}
