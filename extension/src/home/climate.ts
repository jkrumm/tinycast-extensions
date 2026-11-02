// Pure: the recorded climate history (`home climate <hours> --json`) -> parsed
// points, range windows, downsampling, min/max and the absolute-humidity
// "does airing help" rule. Drawing lives in heroes.ts; nothing here touches
// @raycast/api.

export interface ClimatePoint {
  at: number; // epoch ms
  inT: number | null;
  inH: number | null;
  outT: number | null;
  outH: number | null;
}

const HOUR_MS = 3_600_000;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function parseClimate(raw: string): ClimatePoint[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry): ClimatePoint[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const at = typeof e.at === "string" ? Date.parse(e.at) : NaN;
    if (Number.isNaN(at)) return [];
    return [
      {
        at,
        inT: num(e.in_t),
        inH: num(e.in_h),
        outT: num(e.out_t),
        outH: num(e.out_h),
      },
    ];
  });
}

// ─── Ranges ─────────────────────────────────────────────────────────────────

export const CLIMATE_RANGES = ["24h", "48h", "7d", "30d"] as const;
export type ClimateRange = (typeof CLIMATE_RANGES)[number];
export const DEFAULT_RANGE: ClimateRange = "48h";

const RANGE_HOURS: Record<ClimateRange, number> = {
  "24h": 24,
  "48h": 48,
  "7d": 168,
  "30d": 720,
};
// The history is one point per 10 min; longer windows are averaged to stay
// around 150–180 points.
const RANGE_BUCKET_MS: Record<ClimateRange, number | null> = {
  "24h": null,
  "48h": null,
  "7d": HOUR_MS,
  "30d": 4 * HOUR_MS,
};

export const rangeHours = (range: ClimateRange): number => RANGE_HOURS[range];
export const rangeLabel = (range: ClimateRange): string =>
  range === "7d" || range === "30d"
    ? `${RANGE_HOURS[range] / 24} days`
    : `${RANGE_HOURS[range]} h`;

const mean = (values: Array<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0
    ? null
    : known.reduce((a, b) => a + b, 0) / known.length;
};

// Averages points into fixed buckets (ascending, empty buckets skipped); a
// bucket's time is the mean of its points'.
export function downsample(
  points: ClimatePoint[],
  bucketMs: number,
): ClimatePoint[] {
  const buckets = new Map<number, ClimatePoint[]>();
  for (const p of points) {
    const key = Math.floor(p.at / bucketMs);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p);
    else buckets.set(key, [p]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, bucket]) => ({
      at: Math.round(bucket.reduce((sum, p) => sum + p.at, 0) / bucket.length),
      inT: mean(bucket.map((p) => p.inT)),
      inH: mean(bucket.map((p) => p.inH)),
      outT: mean(bucket.map((p) => p.outT)),
      outH: mean(bucket.map((p) => p.outH)),
    }));
}

// The points inside the range's window, downsampled for the long ranges.
export function shapeForRange(
  points: ClimatePoint[],
  range: ClimateRange,
  now: number,
): ClimatePoint[] {
  const from = now - RANGE_HOURS[range] * HOUR_MS;
  const inside = points.filter((p) => p.at >= from && p.at <= now);
  const bucket = RANGE_BUCKET_MS[range];
  return bucket ? downsample(inside, bucket) : inside;
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export interface Extent {
  min: number;
  max: number;
}

const known = (values: Array<number | null>): number[] =>
  values.filter((v): v is number => v !== null);

const extent = (values: Array<number | null>): Extent | null => {
  const k = known(values);
  return k.length === 0 ? null : { min: Math.min(...k), max: Math.max(...k) };
};

const latest = (values: Array<number | null>): number | null =>
  known(values.slice().reverse())[0] ?? null;

export interface ClimateStats {
  inT: Extent | null; // last 24 h
  inH: Extent | null;
  inTNow: number | null; // latest recorded
  inHNow: number | null;
  outTNow: number | null;
  outHNow: number | null;
}

export function climateStats(
  points: ClimatePoint[],
  now: number,
): ClimateStats {
  const recent = points.filter((p) => p.at >= now - 24 * HOUR_MS);
  return {
    inT: extent(recent.map((p) => p.inT)),
    inH: extent(recent.map((p) => p.inH)),
    inTNow: latest(points.map((p) => p.inT)),
    inHNow: latest(points.map((p) => p.inH)),
    outTNow: latest(points.map((p) => p.outT)),
    outHNow: latest(points.map((p) => p.outH)),
  };
}

// ─── Absolute humidity (Magnus) ─────────────────────────────────────────────

// Outdoor air must hold at least this much less water (g/m³) than indoor air
// for airing to dry the flat — the same threshold as the mini's alert job.
export const DRY_DELTA = 1;

export function absoluteHumidity(tempC: number, rhPct: number): number {
  const saturation = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
  return (saturation * rhPct * 2.1674) / (273.15 + tempC);
}

export interface Airing {
  inside: number; // g/m³
  outside: number;
  helps: boolean;
}

export function airing(
  inT: number | null,
  inH: number | null,
  outT: number | null,
  outH: number | null,
): Airing | null {
  if (inT === null || inH === null || outT === null || outH === null)
    return null;
  const inside = absoluteHumidity(inT, inH);
  const outside = absoluteHumidity(outT, outH);
  return { inside, outside, helps: outside <= inside - DRY_DELTA };
}

// ─── Menu bar ───────────────────────────────────────────────────────────────

// `24 h: 21.4–22.6 °C · 40–45 %`; null with no inside data.
export function menuClimateLine(
  points: ClimatePoint[] | null,
  now: number,
): string | null {
  if (!points) return null;
  const { inT, inH } = climateStats(points, now);
  const t = inT && `${inT.min.toFixed(1)}–${inT.max.toFixed(1)} °C`;
  const h = inH && `${Math.round(inH.min)}–${Math.round(inH.max)} %`;
  const parts = [t, h].filter(Boolean);
  return parts.length > 0 ? `24 h: ${parts.join(" · ")}` : null;
}
