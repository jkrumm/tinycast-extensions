// Images for the Home Climate History view — pure (no @raycast/api), so the
// unit tests and `make previews` render exactly what the command embeds. Top
// down: a status panel (inside temperature + humidity, outside), one quiet
// metrics grid, then the temperature and humidity charts. Every number is
// drawn once.

import {
  PanelColumn,
  RAYCAST_COLOR,
  RaycastColor,
  StatCard,
  lineChart,
  statCards,
  statusPanel,
  toDataUri,
} from "../lib/svg";
import { nightSpans } from "../van/sun";
import {
  ClimatePoint,
  ClimateRange,
  airing,
  climateStats,
  rangeHours,
} from "./climate";
import { COLD_C, DRY_AT, HUMID_AT, humidityHint } from "./format";
import { HomeStatus, StatusCache } from "./types";

const HOUR_MS = 3_600_000;
const AXIS_WIDTH = 56;
const CHART_HEIGHT = 210;
// Munich — the flat; night shading is sunset → sunrise here.
const LOCATION = { lat: 48.137, lon: 11.575 };

const { blue, green, orange, red } = RAYCAST_COLOR;

export interface ClimateInput {
  status: StatusCache | null;
  points: ClimatePoint[];
  now: number;
}

const fixed = (v: number | null, digits: number): string | null =>
  v === null ? null : v.toFixed(digits);

// The inside reading: the live status when it has one, else the last
// recorded point.
function inside(input: ClimateInput) {
  const stats = climateStats(input.points, input.now);
  const climate = input.status?.status.climate ?? null;
  return {
    t: climate?.temperatureC ?? stats.inTNow,
    h: climate?.humidityPct ?? stats.inHNow,
    stats,
    climate,
  };
}

function humidityColor(h: number) {
  if (h >= HUMID_AT) return red;
  if (h <= DRY_AT) return orange;
  return green;
}

function temperatureColor(t: number) {
  if (t < COLD_C) return blue;
  if (t > 26) return orange;
  return green;
}

export function panelColumns(input: ClimateInput): PanelColumn[] {
  const { t, h, stats, climate } = inside(input);
  const battery =
    climate?.batteryPct != null
      ? `battery ${Math.round(climate.batteryPct)} %`
      : null;
  const columns: PanelColumn[] = [
    {
      label: "Inside",
      value: fixed(t, 1),
      unit: "°C",
      percent: t === null ? undefined : ((t - 10) / 20) * 100,
      color: t === null ? undefined : temperatureColor(t),
      sub:
        climate?.reachable === false
          ? "sensor unreachable · last known"
          : ["Eve Room", battery].filter(Boolean).join(" · "),
    },
    {
      label: "Humidity",
      value: fixed(h, 0),
      unit: "%",
      percent: h === null ? undefined : h,
      color: h === null ? undefined : humidityColor(h),
      sub: h === null ? undefined : (humidityHint(h) ?? "comfortable"),
    },
    {
      label: "Outside",
      value: fixed(stats.outTNow, 1),
      unit: "°C",
      sub:
        stats.outHNow === null
          ? "no data"
          : `${Math.round(stats.outHNow)} % humidity`,
    },
  ];
  return columns;
}

export const panelImage = (input: ClimateInput): string =>
  toDataUri(statusPanel({ columns: panelColumns(input) }));

const range = (min: number, max: number, digits: number): string =>
  `${min.toFixed(digits)}–${max.toFixed(digits)}`;

const yesNo = (v: boolean | null): string =>
  v === null ? "—" : v ? "Yes" : "No";

export function metricCards(input: ClimateInput): StatCard[] {
  const { t, h, stats } = inside(input);
  const status: HomeStatus | null = input.status?.status ?? null;
  const air = airing(t, h, stats.outTNow, stats.outHNow);
  return [
    {
      label: "Temp · 24 h",
      value: stats.inT && range(stats.inT.min, stats.inT.max, 1),
      unit: "°C",
    },
    {
      label: "Humidity · 24 h",
      value: stats.inH && range(stats.inH.min, stats.inH.max, 0),
      unit: "%",
    },
    {
      label: "Water in / out",
      value: air && `${air.inside.toFixed(1)} / ${air.outside.toFixed(1)}`,
      unit: "g/m³",
    },
    {
      label: "Airing helps",
      value: air ? yesNo(air.helps) : "—",
      tone: air?.helps ? "good" : undefined,
    },
    {
      label: "Nami",
      value:
        status?.namiHome == null ? "—" : status.namiHome ? "Home" : "With you",
    },
    { label: "Someone home", value: yesNo(status?.someoneHome ?? null) },
  ];
}

export const metricsImage = (input: ClimateInput): string =>
  toDataUri(
    statCards({ cards: metricCards(input), size: "compact", columns: 3 }),
  );

// ─── Charts ─────────────────────────────────────────────────────────────────

function chart(opts: {
  points: ClimatePoint[];
  range: ClimateRange;
  now: number;
  inside: (p: ClimatePoint) => number | null;
  outside: (p: ClimatePoint) => number | null;
  format: (v: number) => string;
  domain?: [number, number];
  extrema?: boolean;
  reference: Array<{ value: number; label: string; color: RaycastColor }>;
}): string | null {
  const { points, now } = opts;
  const insideValues = points.map(opts.inside);
  const outsideValues = points.map(opts.outside);
  if (![...insideValues, ...outsideValues].some((v) => v !== null)) return null;
  const hours = rangeHours(opts.range);
  const from = now - hours * HOUR_MS;
  return toDataUri(
    lineChart(
      {
        times: points.map((p) => p.at),
        domain: [from, now],
        // Night bands read well up to two days; a week gets weekday labels
        // only, a month the date ticks.
        dayAxis: hours <= 168,
        shading:
          hours <= 48 ? nightSpans({ from, to: now, location: LOCATION }) : [],
        axisWidth: AXIS_WIDTH,
        series: [
          {
            label: "Inside",
            color: orange,
            values: insideValues,
            axis: "left",
            format: opts.format,
            extrema: opts.extrema,
            domain: opts.domain,
            reference: opts.reference,
          },
          {
            label: "Outside",
            color: blue,
            values: outsideValues,
            axis: "left",
            format: opts.format,
            domain: opts.domain,
          },
        ],
      },
      { height: CHART_HEIGHT },
    ),
  );
}

const formatTemp = (v: number): string => `${Math.round(v * 10) / 10}°`;

export const temperatureChartImage = (
  points: ClimatePoint[],
  range: ClimateRange,
  now: number,
): string | null =>
  chart({
    points,
    range,
    now,
    inside: (p) => p.inT,
    outside: (p) => p.outT,
    format: formatTemp,
    extrema: true,
    reference: [{ value: COLD_C, label: `${COLD_C}° cold`, color: blue }],
  });

export const humidityChartImage = (
  points: ClimatePoint[],
  range: ClimateRange,
  now: number,
): string | null =>
  chart({
    points,
    range,
    now,
    inside: (p) => p.inH,
    outside: (p) => p.outH,
    format: (v) => `${Math.round(v)}%`,
    domain: [0, 100],
    reference: [
      { value: HUMID_AT, label: `${HUMID_AT}% humid`, color: red },
      { value: DRY_AT, label: `${DRY_AT}% dry`, color: orange },
    ],
  });
