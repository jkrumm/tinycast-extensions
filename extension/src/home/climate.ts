// Pure: the recorded climate history (`home climate --json`) -> parsed points,
// summaries and the Detail markdown. Charts come from lib/svg; nothing here
// touches @raycast/api.

import { RAYCAST_COLOR, lineChart, toDataUri } from "../lib/svg";

export interface ClimatePoint {
  at: number; // epoch ms
  inT: number | null;
  inH: number | null;
  outT: number | null;
  outH: number | null;
}

const HOUR_MS = 3_600_000;
// Fewer points than this (10 min apart) and a chart would be a stub.
const MIN_CHART_POINTS = 6;

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

const known = (values: Array<number | null>): number[] =>
  values.filter((v): v is number => v !== null);

const range = (values: number[], digits: number): string | null =>
  values.length === 0
    ? null
    : `${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)}`;

const last24h = (points: ClimatePoint[], now: number): ClimatePoint[] =>
  points.filter((p) => p.at >= now - 24 * HOUR_MS);

// Menu bar line: `24 h: 21.4–22.6 °C · 40–45 %`; null with no inside data.
export function menuClimateLine(
  points: ClimatePoint[] | null,
  now: number,
): string | null {
  if (!points) return null;
  const recent = last24h(points, now);
  const t = range(known(recent.map((p) => p.inT)), 1);
  const h = range(known(recent.map((p) => p.inH)), 0);
  const parts = [t && `${t} °C`, h && `${h} %`].filter(Boolean);
  return parts.length > 0 ? `24 h: ${parts.join(" · ")}` : null;
}

const latest = (values: Array<number | null>): number | null =>
  known(values.slice().reverse())[0] ?? null;

// Three plain lines under the charts.
export function climateSummaryLines(
  points: ClimatePoint[],
  now: number,
): string[] {
  const recent = last24h(points, now);
  const t = range(known(recent.map((p) => p.inT)), 1);
  const h = range(known(recent.map((p) => p.inH)), 0);
  const outT = latest(points.map((p) => p.outT));
  const outH = latest(points.map((p) => p.outH));
  return [
    `Inside temperature, 24 h: ${t ? `${t} °C` : "no data"}`,
    `Inside humidity, 24 h: ${h ? `${h} %` : "no data"}`,
    `Outside now: ${
      [
        outT !== null ? `${outT.toFixed(1)} °C` : null,
        outH !== null ? `${Math.round(outH)} %` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "no data"
    }`,
  ];
}

const startedText = (at: number): string =>
  new Date(at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function chart(
  points: ClimatePoint[],
  inside: (p: ClimatePoint) => number | null,
  outside: (p: ClimatePoint) => number | null,
  format: (v: number) => string,
): string {
  return toDataUri(
    lineChart({
      times: points.map((p) => p.at),
      series: [
        {
          label: "Inside",
          color: RAYCAST_COLOR.orange,
          values: points.map(inside),
          axis: "left",
          format,
        },
        {
          label: "Outside",
          color: RAYCAST_COLOR.blue,
          values: points.map(outside),
          axis: "left",
          format,
        },
      ],
    }),
  );
}

export function climateHistoryMarkdown(
  points: ClimatePoint[],
  now: number,
): string {
  const lines = ["# Climate history", ""];
  if (points.length === 0) {
    lines.push("No climate recorded yet.");
    return lines.join("\n");
  }
  if (points.length < MIN_CHART_POINTS) {
    lines.push(
      `Recording started at ${startedText(points[0].at)}, the chart fills in over the next hours.`,
    );
  } else {
    lines.push(
      "### Temperature · last 48 h",
      "",
      `![Temperature](${chart(
        points,
        (p) => p.inT,
        (p) => p.outT,
        (v) => `${v.toFixed(0)}°`,
      )})`,
      "",
      "### Humidity · last 48 h",
      "",
      `![Humidity](${chart(
        points,
        (p) => p.inH,
        (p) => p.outH,
        (v) => `${v.toFixed(0)}%`,
      )})`,
    );
  }
  lines.push("", ...climateSummaryLines(points, now).map((l) => `- ${l}`));
  return lines.join("\n");
}
