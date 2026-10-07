// Time-series charts: `areaChart` / `lineChart` (one or two series, optional
// second y-axis, real time on x) and the tiny inline `sparkline`. d3-scale and
// d3-shape are used as math only — scales, nice ticks, monotone curves — the
// output is a plain SVG string.

import { scaleLinear, scaleTime } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";
import { timeFormat } from "d3-time-format";
import {
  Box,
  CHIP_HEIGHT,
  HERO_COL_WIDTH,
  RaycastColor,
  Size,
  THEME,
  chip,
  chipWidth,
  clamp,
  emptyChart,
  fadeGradient,
  formatNumber,
  isFiniteNumber,
  n,
  overlaps,
  svgDocument,
  text,
  textWidth,
} from "./core";

export interface ReferenceLine {
  value: number;
  label?: string; // short, drawn above the left end — e.g. "20% low"
  color?: RaycastColor; // defaults to the series colour
}

export interface TimeSeries {
  label?: string; // legend entry; omit for an unlabeled single-series chart
  color: RaycastColor;
  // One value per `times` entry; null / NaN = not measured (the line breaks).
  values: Array<number | null>;
  // This series' own timestamps (epoch ms, ascending), one per value — for two
  // series sampled at different moments (dense solar W, sparse readings) that
  // must not share a time axis. Default: the chart's `times`.
  times?: number[];
  // Default: the first series on the left axis, the second on the right.
  axis?: "left" | "right";
  domain?: [number, number]; // fixed y range (e.g. SoC 0–100); default = data range
  format?: (v: number) => string; // ticks, last-value chip, extrema labels
  fill?: boolean; // gradient area under the line; default per chart kind
  reference?: ReferenceLine[]; // dashed threshold lines in this series' scale
  extrema?: boolean; // mark and label the min and max point
}

export interface TimeChartSpec {
  times: number[]; // epoch ms, ascending — x is proportional to time
  series: TimeSeries[]; // the first two are drawn
  xFormat?: (t: number) => string; // default: chosen from the tick step
  // false: no last-value chip or legend value — when the number is already
  // drawn elsewhere in the view (a status panel). Default true.
  lastValues?: boolean;
  // Fix the x axis to this window instead of the data's own span — a 3-day
  // chart over sparse samples must still read as 3 days.
  domain?: [number, number];
  // Faint background spans (epoch ms) behind the plot, e.g. the night.
  shading?: { from: number; to: number }[];
  // Weekday labels centred in each local day and a hairline at every midnight,
  // instead of d3's nice ticks.
  dayAxis?: boolean;
  // Dots (optionally labelled) at exact measurements on the left axis' scale —
  // e.g. the battery-% readings on the estimated curve. A label that would
  // collide with the previous one is dropped (its dot stays).
  marks?: ChartMark[];
  // Reserve at least this much width for the left axis' tick labels, so two
  // stacked charts line up their plot areas.
  axisWidth?: number;
  // No x labels (and no room for them): the chart below carries the axis.
  hideXLabels?: boolean;
}

export interface ChartMark {
  t: number; // epoch ms
  v: number; // value on the first (left) axis
  label?: string; // omit for a bare dot
  color?: RaycastColor;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// d3 picks "nice" local-time ticks; the label format follows the tick step so
// 10-minute ticks read "14:10", 12-hour ticks "Sat 12:00", daily ticks "Sat",
// and a month of weekly ticks "5 Oct".
function defaultTimeFormat(opts: {
  span: number;
  step: number;
}): (t: number) => string {
  const { span, step } = opts;
  const pattern =
    step < DAY
      ? span <= 1.5 * DAY
        ? "%H:%M"
        : "%a %H:%M"
      : span <= 8 * DAY
        ? "%a"
        : "%-d %b";
  const format = timeFormat(pattern);
  return (t) => format(new Date(t));
}

interface Layer {
  series: TimeSeries;
  side: "left" | "right";
  fill: boolean;
  format: (v: number) => string;
  // Aligned with `times`; v === null is a gap.
  points: Array<{ t: number; v: number | null }>;
  valid: Array<{ t: number; v: number }>;
}

interface Axis {
  side: "left" | "right";
  layers: Layer[];
  y: (v: number) => number;
  domain: [number, number];
  ticks: number[];
  format: (v: number) => string;
}

function buildLayers(spec: TimeChartSpec, fillDefault: boolean): Layer[] {
  return spec.series
    .slice(0, 2)
    .map((series, index): Layer => {
      const points = (series.times ?? spec.times).map((t, i) => {
        const v = series.values[i];
        return { t, v: isFiniteNumber(t) && isFiniteNumber(v) ? v : null };
      });
      return {
        series,
        side: series.axis ?? (index === 0 ? "left" : "right"),
        fill: series.fill ?? fillDefault,
        format: series.format ?? formatNumber,
        points,
        valid: points.flatMap((p) =>
          p.v === null ? [] : [{ t: p.t, v: p.v }],
        ),
      };
    })
    .filter((layer) => layer.valid.length > 0);
}

// The smallest "nice" step (1, 2, 2.5, 5 × 10^k) whose `intervals` steps cover
// [lo, hi], with the range snapped to a multiple of the step — so a second y
// axis can share the first axis' gridlines instead of drawing its own.
function alignedDomain(
  lo: number,
  hi: number,
  intervals: number,
): { domain: [number, number]; ticks: number[] } {
  const power = Math.floor(Math.log10((hi - lo) / intervals)) - 1;
  for (let k = power; ; k++) {
    for (const mantissa of [1, 2, 2.5, 5]) {
      const step = mantissa * 10 ** k;
      const start = Math.floor(lo / step + 1e-9) * step;
      if (start + intervals * step >= hi - 1e-9) {
        const ticks = Array.from({ length: intervals + 1 }, (_, i) =>
          Number((start + i * step).toPrecision(12)),
        );
        return { domain: [ticks[0], ticks[intervals]], ticks };
      }
    }
  }
}

function buildAxis(opts: {
  side: "left" | "right";
  layers: Layer[];
  top: number;
  bottom: number;
  // Interval count of the gridline axis: draw this axis' ticks on those lines.
  alignTo?: number;
}): Axis {
  const { side, layers, top, bottom } = opts;
  const values = layers.flatMap((l) => l.valid.map((p) => p.v));
  const filled = layers.some((l) => l.fill);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const fixed = layers.find((l) => l.series.domain)?.series.domain;
  if (fixed) {
    [lo, hi] = fixed;
  } else {
    // A filled series is anchored at zero; a plain line gets headroom both ways.
    if (filled && lo > 0) lo = 0;
    if (filled && hi < 0) hi = 0;
    if (hi - lo < 1e-9) {
      const pad = Math.abs(hi) * 0.1 || 1;
      lo -= pad;
      hi += pad;
    } else {
      const pad = (hi - lo) * 0.08;
      hi += pad;
      if (!(filled && lo === 0)) lo -= pad;
    }
  }
  if (opts.alignTo && !fixed) {
    const aligned = alignedDomain(lo, hi, opts.alignTo);
    const scale = scaleLinear().domain(aligned.domain).range([bottom, top]);
    return {
      side,
      layers,
      y: (v) => scale(v),
      domain: aligned.domain,
      ticks: aligned.ticks,
      format: layers[0].format,
    };
  }
  const tickCount = clamp(Math.floor((bottom - top) / 34), 2, 5);
  const scale = scaleLinear()
    .domain([lo, hi])
    .nice(tickCount)
    .range([bottom, top]);
  const domain = scale.domain() as [number, number];
  return {
    side,
    layers,
    y: (v) => scale(v),
    domain,
    ticks: scale.ticks(tickCount),
    format: layers[0].format,
  };
}

// Isolated points (a gap on both sides) have no line to draw — they get a dot.
function isolatedIndexes(points: Layer["points"]): number[] {
  return points.flatMap((p, i) =>
    p.v !== null && points[i - 1]?.v == null && points[i + 1]?.v == null
      ? [i]
      : [],
  );
}

function timeChart(
  spec: TimeChartSpec,
  opts: Size | undefined,
  fillDefault: boolean,
): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 180;
  const layers = buildLayers(spec, fillDefault);
  if (layers.length === 0) return emptyChart({ width, height });

  const padX = THEME.pad.x;
  const hasLegend = layers.some((l) => l.series.label);
  const top = hasLegend ? 36 : THEME.pad.top + 6;
  const bottom = height - (spec.hideXLabels ? 8 : 26);

  const sides = (["left", "right"] as const)
    .map((side) => ({ side, layers: layers.filter((l) => l.side === side) }))
    .filter((group) => group.layers.length > 0)
    .reduce<Axis[]>((axes, group) => {
      const first = axes[0];
      return [
        ...axes,
        buildAxis({
          ...group,
          top,
          bottom,
          alignTo: first ? first.ticks.length - 1 : undefined,
        }),
      ];
    }, []);
  const left = sides.find((a) => a.side === "left");
  const right = sides.find((a) => a.side === "right");
  const gridAxis = left ?? right!;

  const tickWidth = (axis?: Axis) =>
    axis
      ? Math.max(
          ...axis.ticks.map((t) => textWidth(axis.format(t), THEME.font.tick)),
        ) + 8
      : 0;
  const plotL = padX + Math.max(tickWidth(left), spec.axisWidth ?? 0);
  const plotR = width - padX - tickWidth(right);

  const times = layers.flatMap((l) => l.valid.map((p) => p.t));
  let t0 = spec.domain ? spec.domain[0] : Math.min(...times);
  let t1 = spec.domain ? spec.domain[1] : Math.max(...times);
  if (t1 - t0 < 1) {
    t0 -= HOUR / 2;
    t1 += HOUR / 2;
  }
  const xScale = scaleTime().domain([t0, t1]).range([plotL, plotR]);
  const x = (t: number) => xScale(t);
  const axisOf = (layer: Layer) => (layer.side === "left" ? left : right)!;

  const defs = new Map<string, string>();
  const backdrop: string[] = [];
  const grid: string[] = [];
  const areas: string[] = [];
  const references: string[] = [];
  const lines: string[] = [];
  const markers: string[] = [];
  const labels: string[] = [];

  // Shaded spans (the night): quiet fills behind everything, clipped to the plot.
  for (const span of spec.shading ?? []) {
    const from = clamp(x(span.from), plotL, plotR);
    const to = clamp(x(span.to), plotL, plotR);
    if (to - from < 0.5) continue;
    backdrop.push(
      `<rect x="${n(from)}" y="${n(top)}" width="${n(to - from)}" height="${n(bottom - top)}" fill="${THEME.color.muted}" fill-opacity="${THEME.opacity.shade}" />`,
    );
  }

  // Hairline gridlines at the first axis' nice ticks, a stronger baseline, and
  // a zero line wherever an axis crosses zero.
  for (const tick of gridAxis.ticks) {
    const y = Math.round(gridAxis.y(tick)) + 0.5;
    if (Math.abs(y - bottom) < 1) continue;
    grid.push(
      `<line x1="${n(plotL)}" y1="${y}" x2="${n(plotR)}" y2="${y}" stroke="${THEME.color.muted}" stroke-opacity="${THEME.opacity.grid}" stroke-width="${THEME.stroke.hairline}" />`,
    );
  }
  grid.push(
    `<line x1="${n(plotL)}" y1="${bottom + 0.5}" x2="${n(plotR)}" y2="${bottom + 0.5}" stroke="${THEME.color.muted}" stroke-opacity="${THEME.opacity.axis}" stroke-width="${THEME.stroke.hairline}" />`,
  );
  for (const axis of sides) {
    const [lo, hi] = axis.domain;
    if (lo < 0 && hi > 0) {
      const y = Math.round(axis.y(0)) + 0.5;
      grid.push(
        `<line x1="${n(plotL)}" y1="${y}" x2="${n(plotR)}" y2="${y}" stroke="${THEME.color.muted}" stroke-opacity="${THEME.opacity.axis}" stroke-width="${THEME.stroke.hairline}" />`,
      );
    }
  }

  // Y tick labels — quiet, muted, the second axis on the right.
  for (const axis of sides) {
    for (const tick of axis.ticks) {
      labels.push(
        text({
          x: axis.side === "left" ? plotL - 8 : plotR + 8,
          y: axis.y(tick) + THEME.font.tick * 0.36,
          content: axis.format(tick),
          size: THEME.font.tick,
          color: THEME.color.muted,
          anchor: axis.side === "left" ? "end" : "start",
        }),
      );
    }
  }

  for (const layer of layers) {
    const axis = axisOf(layer);
    const { color } = layer.series;
    const [lo, hi] = axis.domain;
    const pixels = layer.points.map((p) => ({
      x: x(p.t),
      y: p.v === null ? null : axis.y(p.v),
    }));

    if (layer.fill) {
      const gradient = fadeGradient({
        color,
        from: THEME.opacity.areaTop,
        to: THEME.opacity.areaBottom,
      });
      defs.set(gradient.id, gradient.def);
      const d = area<{ x: number; y: number | null }>()
        .defined((p) => p.y !== null)
        .x((p) => p.x)
        .y0(axis.y(clamp(0, lo, hi)))
        .y1((p) => p.y ?? 0)
        .curve(curveMonotoneX)
        .digits(1)(pixels);
      if (d)
        areas.push(
          `<path d="${d}" fill="url(#${gradient.id})" stroke="none" />`,
        );
    }

    for (const ref of layer.series.reference ?? []) {
      if (ref.value < lo || ref.value > hi) continue;
      const y = Math.round(axis.y(ref.value)) + 0.5;
      const refColor = ref.color ?? color;
      references.push(
        `<line x1="${n(plotL)}" y1="${y}" x2="${n(plotR)}" y2="${y}" stroke="${refColor}" stroke-opacity="0.75" stroke-width="${THEME.stroke.hairline}" stroke-dasharray="3 4" />`,
      );
      if (ref.label) {
        references.push(
          text({
            x: plotL + 4,
            y: y - 4,
            content: ref.label,
            size: THEME.font.tick,
            color: THEME.color.muted,
            anchor: "start",
          }),
        );
      }
    }

    const d = line<{ x: number; y: number | null }>()
      .defined((p) => p.y !== null)
      .x((p) => p.x)
      .y((p) => p.y ?? 0)
      .curve(curveMonotoneX)
      .digits(1)(pixels);
    if (d) {
      lines.push(
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="${THEME.stroke.line}" stroke-linejoin="round" stroke-linecap="round" />`,
      );
    }
    for (const i of isolatedIndexes(layer.points)) {
      markers.push(
        `<circle cx="${n(pixels[i].x)}" cy="${n(pixels[i].y ?? 0)}" r="2.5" fill="${color}" />`,
      );
    }
  }

  // Labelled measurement marks, left to right; a label that would touch the
  // previous one is skipped (the dot stays).
  let lastLabelEnd = -Infinity;
  for (const mark of [...(spec.marks ?? [])].sort((a, b) => a.t - b.t)) {
    const px = x(mark.t);
    if (px < plotL || px > plotR || !isFiniteNumber(mark.v)) continue;
    const py = (left ?? right!).y(mark.v);
    const color = mark.color ?? THEME.color.accent;
    markers.push(
      `<circle cx="${n(px)}" cy="${n(py)}" r="7" fill="${color}" fill-opacity="0.2" /><circle cx="${n(px)}" cy="${n(py)}" r="3.5" fill="${color}" />`,
    );
    if (!mark.label) continue;
    const w = textWidth(mark.label, THEME.font.tick);
    const cx = clamp(px, plotL + w / 2, plotR - w / 2);
    if (cx - w / 2 < lastLabelEnd + 6) continue;
    lastLabelEnd = cx + w / 2;
    labels.push(
      text({
        x: cx,
        y: Math.max(top + 6, py - 12),
        content: mark.label,
        size: THEME.font.tick,
        color: THEME.color.text,
        weight: 600,
      }),
    );
  }

  // Last-value dot per series, plus a value chip for a single-series chart.
  const chips: Box[] = [];
  const lastX: number[] = [];
  for (const layer of layers) {
    const axis = axisOf(layer);
    const { color } = layer.series;
    const last = layer.valid[layer.valid.length - 1];
    const px = x(last.t);
    const py = axis.y(last.v);
    lastX.push(px);
    markers.push(
      `<circle cx="${n(px)}" cy="${n(py)}" r="7" fill="${color}" fill-opacity="0.2" /><circle cx="${n(px)}" cy="${n(py)}" r="3.5" fill="${color}" />`,
    );

    // Two series: the last values live in the legend row instead, where two
    // chips fighting over the right edge of the plot can't collide.
    if (layers.length > 1 || spec.lastValues === false) continue;
    const content = layer.format(last.v);
    const w = chipWidth(content);
    const boxX = Math.max(plotL, Math.min(px + 4, width - 6) - w);
    // The line arrives from the left: put the chip on the side it is not on.
    const earlier = [...layer.valid]
      .reverse()
      .find((p) => px - x(p.t) >= Math.min(w, 40));
    const comesFromAbove = earlier ? axis.y(earlier.v) < py : false;
    const above = py - 10 - CHIP_HEIGHT;
    const below = py + 10;
    const preferred = comesFromAbove ? below : above;
    const fallback = comesFromAbove ? above : below;
    const candidates = [preferred, fallback].map((y) =>
      clamp(y, top - 8, bottom - CHIP_HEIGHT - 2),
    );
    const box =
      candidates
        .map((y): Box => ({ x: boxX, y, width: w, height: CHIP_HEIGHT }))
        .find((b) => !chips.some((c) => overlaps(b, c))) ??
      ({
        x: boxX,
        y: candidates[0],
        width: w,
        height: CHIP_HEIGHT,
      } satisfies Box);
    chips.push(box);
    labels.push(chip({ box, content, color }));
  }

  // Min / max markers, skipped when they'd collide with a last-value chip.
  for (const [i, layer] of layers.entries()) {
    if (!layer.series.extrema || layer.valid.length < 3) continue;
    const axis = axisOf(layer);
    const lo = layer.valid.reduce((a, p) => (p.v < a.v ? p : a));
    const hi = layer.valid.reduce((a, p) => (p.v > a.v ? p : a));
    if (hi.v - lo.v < 1e-9) continue;
    for (const [point, above] of [
      [hi, true],
      [lo, false],
    ] as const) {
      const px = x(point.t);
      if (Math.abs(px - lastX[i]) < 56) continue;
      const py = axis.y(point.v);
      // A minimum resting on the floor (night-time 0 W) is noise, not a mark.
      if (!above && py > bottom - 12) continue;

      const content = layer.format(point.v);
      const w = textWidth(content, THEME.font.tick);
      const anchor =
        px - w / 2 < plotL ? "start" : px + w / 2 > plotR ? "end" : "middle";
      markers.push(
        `<circle cx="${n(px)}" cy="${n(py)}" r="3" fill="${layer.series.color}" fill-opacity="0.3" stroke="${layer.series.color}" stroke-width="${THEME.stroke.marker}" />`,
      );
      labels.push(
        text({
          x: px,
          y: above && py - 9 >= top + 6 ? py - 9 : py + 17,
          content,
          size: THEME.font.tick,
          color: THEME.color.muted,
          anchor,
        }),
      );
    }
  }

  if (spec.dayAxis) {
    // One weekday label per local day, centred in its (clipped) span, and a
    // hairline where each new day starts.
    const dayLabel = timeFormat("%a");
    const cursor = new Date(t0);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() < t1) {
      const dayStart = cursor.getTime();
      cursor.setDate(cursor.getDate() + 1);
      const from = Math.max(dayStart, t0);
      const to = Math.min(cursor.getTime(), t1);
      if (dayStart > t0) {
        grid.push(
          `<line x1="${n(x(dayStart))}" y1="${n(top)}" x2="${n(x(dayStart))}" y2="${n(bottom)}" stroke="${THEME.color.muted}" stroke-opacity="${THEME.opacity.grid}" stroke-width="${THEME.stroke.hairline}" />`,
        );
      }
      if (spec.hideXLabels || x(to) - x(from) < 36) continue;
      labels.push(
        text({
          x: (x(from) + x(to)) / 2,
          y: bottom + 17,
          content: dayLabel(new Date(dayStart)),
          size: THEME.font.tick,
          color: THEME.color.muted,
        }),
      );
    }
  } else if (!spec.hideXLabels) {
    // X axis: d3's nice time ticks, labels clamped inside the canvas.
    const tickCount = Math.max(2, Math.floor((plotR - plotL) / 110));
    const xTicks = xScale.ticks(tickCount).map(Number);
    const step = xTicks.length > 1 ? xTicks[1] - xTicks[0] : t1 - t0;
    const xFormat = spec.xFormat ?? defaultTimeFormat({ span: t1 - t0, step });
    let edge = -Infinity;
    for (const tick of xTicks) {
      const content = xFormat(tick);
      const w = textWidth(content, THEME.font.tick);
      const cx = clamp(x(tick), padX + w / 2, width - padX - w / 2);
      if (cx - w / 2 < edge + 10) continue;
      edge = cx + w / 2;
      labels.push(
        text({
          x: cx,
          y: bottom + 17,
          content,
          size: THEME.font.tick,
          color: THEME.color.muted,
        }),
      );
    }
  }

  // Legend: a dot and a quiet label per named series; with two series the last
  // values are appended in bold.
  let legendX = padX;
  for (const layer of layers) {
    if (!layer.series.label) continue;
    const last = layer.valid[layer.valid.length - 1];
    const value = layers.length > 1 ? layer.format(last.v) : "";
    labels.push(
      `<circle cx="${legendX + 4}" cy="16" r="4" fill="${layer.series.color}" />`,
      text({
        x: legendX + 14,
        y: 20,
        content: layer.series.label,
        size: THEME.font.label,
        color: THEME.color.muted,
        weight: 500,
        anchor: "start",
      }),
    );
    legendX += 14 + textWidth(layer.series.label, THEME.font.label);
    if (value && spec.lastValues !== false) {
      labels.push(
        text({
          x: legendX + 10,
          y: 20,
          content: value,
          size: THEME.font.value,
          color: THEME.color.text,
          weight: 600,
          anchor: "start",
        }),
      );
      legendX += 10 + textWidth(value, THEME.font.value);
    }
    legendX += 20;
  }

  const body = [
    defs.size > 0 ? `<defs>${[...defs.values()].join("")}</defs>` : "",
    ...backdrop,
    ...grid,
    ...areas,
    ...references,
    ...lines,
    ...markers,
    ...labels,
  ].join("");
  return svgDocument(width, height, body);
}

// Filled series by default — the "how much, over time" chart (solar W, SoC,
// download Mbps). Set `fill: false` on a series to draw it as a plain line.
export function areaChart(spec: TimeChartSpec, opts?: Size): string {
  return timeChart(spec, opts, true);
}

// Lines by default — for a series that crosses zero or rides on a baseline
// (battery A) and for comparing two curves. `fill: true` opts a series in.
export function lineChart(spec: TimeChartSpec, opts?: Size): string {
  return timeChart(spec, opts, false);
}

// ─── Sparkline ──────────────────────────────────────────────────────────────

export interface SparklineSpec {
  values: Array<number | null>; // evenly spaced; null / NaN leave a gap
  color?: RaycastColor;
  fill?: boolean; // gradient under the line, default true
}

const SPARK_MAX_POINTS = 60;

// A 160 px wide trend gains nothing from hundreds of points: average them into
// at most SPARK_MAX_POINTS buckets (a bucket with no finite value stays a gap).
function downsample(values: SparklineSpec["values"]): SparklineSpec["values"] {
  if (values.length <= SPARK_MAX_POINTS) return values;
  const size = values.length / SPARK_MAX_POINTS;
  return Array.from({ length: SPARK_MAX_POINTS }, (_, i) => {
    const bucket = values
      .slice(Math.floor(i * size), Math.floor((i + 1) * size))
      .filter(isFiniteNumber);
    return bucket.length > 0
      ? bucket.reduce((sum, v) => sum + v, 0) / bucket.length
      : null;
  });
}

// The sparkline drawn inside a box of a larger canvas — what `tile()` embeds.
export function sparklineMarkup(spec: SparklineSpec, box: Box): string {
  const color = spec.color ?? THEME.color.accent;
  const values = downsample(spec.values);
  const points = values.map((v, i) => ({
    i,
    v: isFiniteNumber(v) ? v : null,
  }));
  const valid = points.flatMap((p) =>
    p.v === null ? [] : [{ i: p.i, v: p.v }],
  );
  if (valid.length === 0) return "";

  const inset = 5; // room for the end dot's halo
  const finite = valid.map((p) => p.v);
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const xOf = (i: number) =>
    values.length > 1
      ? box.x + inset + (i / (values.length - 1)) * (box.width - inset * 2)
      : box.x + box.width / 2;
  const yOf = (v: number) =>
    box.y + inset + (1 - (v - lo) / (hi - lo)) * (box.height - inset * 2);

  const pixels = points.map((p) => ({
    x: xOf(p.i),
    y: p.v === null ? null : yOf(p.v),
  }));
  const gradient = fadeGradient({
    color,
    from: THEME.opacity.areaTop,
    to: THEME.opacity.areaBottom,
  });
  const areaPath =
    spec.fill === false
      ? null
      : area<{ x: number; y: number | null }>()
          .defined((p) => p.y !== null)
          .x((p) => p.x)
          .y0(box.y + box.height - 1)
          .y1((p) => p.y ?? 0)
          .curve(curveMonotoneX)
          .digits(1)(pixels);
  const linePath = line<{ x: number; y: number | null }>()
    .defined((p) => p.y !== null)
    .x((p) => p.x)
    .y((p) => p.y ?? 0)
    .curve(curveMonotoneX)
    .digits(1)(pixels);
  const end = valid[valid.length - 1];

  return [
    areaPath
      ? `<defs>${gradient.def}</defs><path d="${areaPath}" fill="url(#${gradient.id})" stroke="none" />`
      : "",
    linePath
      ? `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />`
      : "",
    `<circle cx="${n(xOf(end.i))}" cy="${n(yOf(end.v))}" r="5" fill="${color}" fill-opacity="0.2" /><circle cx="${n(xOf(end.i))}" cy="${n(yOf(end.v))}" r="2.5" fill="${color}" />`,
  ].join("");
}

// Tiny, axis-free trend line: gradient area, monotone line, end dot. For a
// standalone image where a full chart would be noise.
export function sparkline(spec: SparklineSpec, opts?: Size): string {
  const width = opts?.width ?? 160;
  const height = opts?.height ?? 40;
  return svgDocument(
    width,
    height,
    sparklineMarkup(spec, { x: 0, y: 0, width, height }),
  );
}
