// Pure: the Home Climate History markdown. Short history -> a plain message
// instead of a stub chart; otherwise panel, metrics and both charts.

import {
  ClimatePoint,
  ClimateRange,
  rangeLabel,
  shapeForRange,
} from "./climate";
import { formatAge } from "../lib/freshness";
import {
  humidityChartImage,
  metricsImage,
  panelImage,
  temperatureChartImage,
} from "./heroes";
import { StatusCache } from "./types";

// Fewer points than this (10 min apart) and a chart would be a stub.
export const MIN_CHART_POINTS = 6;

const startedText = (at: number): string =>
  new Date(at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export function climateMarkdown(opts: {
  status: StatusCache | null;
  points: ClimatePoint[]; // as fetched for the range, oldest first
  range: ClimateRange;
  now: number;
}): string {
  const { status, points, range, now } = opts;
  const input = { status, points, now };
  const lines = ["# Climate history", ""];
  lines.push(
    `![Status](${panelImage(input)})`,
    "",
    `![Metrics](${metricsImage(input)})`,
  );
  if (status) lines.push("", `_Updated ${formatAge(status.climateAt, now)}_`);

  const shaped = shapeForRange(points, range, now);
  if (points.length === 0) {
    lines.push("", "No climate recorded yet.");
    return lines.join("\n");
  }
  if (shaped.length < MIN_CHART_POINTS) {
    lines.push(
      "",
      `Recording started at ${startedText(points[0].at)}, the chart fills in over the next hours.`,
    );
    return lines.join("\n");
  }
  const temperature = temperatureChartImage(shaped, range, now);
  const humidity = humidityChartImage(shaped, range, now);
  if (temperature)
    lines.push(
      "",
      `### Temperature · last ${rangeLabel(range)}`,
      "",
      `![Temperature](${temperature})`,
    );
  if (humidity)
    lines.push(
      "",
      `### Humidity · last ${rangeLabel(range)}`,
      "",
      `![Humidity](${humidity})`,
    );
  return lines.join("\n");
}
