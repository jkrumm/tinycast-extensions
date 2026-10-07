// Bar charts: `barChart` (vertical columns on a band axis, or horizontal ranked
// rows) and the single labeled `thresholdBar`. d3-scale supplies the band and
// linear scales; the output is a plain SVG string.

import { scaleBand, scaleLinear } from "d3-scale";
import {
  HERO_COL_WIDTH,
  RaycastColor,
  Size,
  THEME,
  clamp,
  emptyChart,
  fadeGradient,
  formatNumber,
  isFiniteNumber,
  n,
  svgDocument,
  text,
  textWidth,
  thresholdColor,
} from "./core";

export interface BarSegment {
  value: number;
  color: RaycastColor;
}

export interface BarItem {
  label: string;
  sublabel?: string; // a second, muted axis line under the label (e.g. the day number under the weekday)
  value: number; // non-finite is drawn as 0 and labelled "—"
  color?: RaycastColor;
  // Stacked bar: segments are stacked from the baseline and `value` is ignored.
  segments?: BarSegment[];
}

export interface BarChartSpec {
  items: BarItem[];
  // "vertical": columns over a band axis (days). "horizontal": ranked rows
  // (spend by lane). Default vertical.
  orientation?: "vertical" | "horizontal";
  color?: RaycastColor; // default bar colour
  format?: (v: number) => string;
  labels?: boolean; // value labels; false shows y-axis tick labels instead. Default true.
  // "extremes": label only the highlighted and the tallest bar, however many fit;
  // "max": only the tallest.
  labelMode?: "auto" | "extremes" | "max";
  // Vertical only: this bar is drawn at full strength, the rest dimmed.
  // "last" = the final item (today).
  highlight?: number | "last";
  // false: the highlighted bar is marked (bold axis label, its value label) but
  // the others are not dimmed — for colours that turn muddy at reduced strength.
  dim?: boolean;
  // Vertical only: a dashed reference line, e.g. the average.
  threshold?: { value: number; label?: string; color?: RaycastColor };
}

function totalOf(item: BarItem): number {
  if (item.segments) {
    return item.segments.reduce(
      (sum, s) => sum + (isFiniteNumber(s.value) ? s.value : 0),
      0,
    );
  }
  return isFiniteNumber(item.value) ? item.value : 0;
}

// A bar with rounded outer corners only — top for a positive value, bottom for
// a negative one — drawn from the baseline `yBase` to `yEnd`.
function barPath(opts: {
  x: number;
  width: number;
  yBase: number;
  yEnd: number;
  radius: number;
}): string {
  const { x, width, yBase, yEnd } = opts;
  const r = Math.min(opts.radius, width / 2, Math.abs(yBase - yEnd));
  const x2 = x + width;
  if (yEnd <= yBase) {
    return `M${n(x)},${n(yBase)}V${n(yEnd + r)}A${n(r)},${n(r)} 0 0 1 ${n(x + r)},${n(yEnd)}H${n(x2 - r)}A${n(r)},${n(r)} 0 0 1 ${n(x2)},${n(yEnd + r)}V${n(yBase)}Z`;
  }
  return `M${n(x)},${n(yBase)}V${n(yEnd - r)}A${n(r)},${n(r)} 0 0 0 ${n(x + r)},${n(yEnd)}H${n(x2 - r)}A${n(r)},${n(r)} 0 0 0 ${n(x2)},${n(yEnd - r)}V${n(yBase)}Z`;
}

function verticalBars(spec: BarChartSpec, opts: Size | undefined): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 190;
  const { items } = spec;
  const format = spec.format ?? formatNumber;
  const showLabels = spec.labels ?? true;
  const baseColor = spec.color ?? THEME.color.accent;
  const highlight =
    spec.highlight === "last" ? items.length - 1 : spec.highlight;

  const totals = items.map(totalOf);
  const lo = Math.min(0, ...totals);
  const hi = Math.max(0, ...totals, spec.threshold?.value ?? 0);
  const top = showLabels ? 30 : 16;
  // Negative bars hang below the baseline: leave room for their labels above the x labels.
  const twoLineAxis = items.some((i) => i.sublabel);
  const axisH = twoLineAxis ? 40 : 26;
  const bottom = height - axisH - (lo < 0 ? 16 : 0);
  const tickCount = clamp(Math.floor((bottom - top) / 40), 2, 4);
  const y = scaleLinear()
    .domain([lo, hi - lo < 1e-9 ? lo + 1 : hi])
    .nice(tickCount)
    .range([bottom, top]);
  const ticks = y.ticks(tickCount);

  const tickW = showLabels
    ? 0
    : Math.max(...ticks.map((t) => textWidth(format(t), THEME.font.tick))) + 8;
  const plotL = THEME.pad.x + tickW;
  const plotR = width - THEME.pad.x;
  const band = scaleBand<number>()
    .domain(items.map((_, i) => i))
    .range([plotL, plotR])
    .paddingInner(0.34)
    .paddingOuter(0.17);
  const bandW = band.step();
  const barW = Math.min(band.bandwidth(), 56);
  const yBase = y(0);

  const parts: string[] = [];
  const defs = new Map<string, string>();

  for (const tick of ticks) {
    const ty = Math.round(y(tick)) + 0.5;
    if (Math.abs(ty - yBase) >= 1) {
      parts.push(
        `<line x1="${n(plotL)}" y1="${ty}" x2="${n(plotR)}" y2="${ty}" stroke="${THEME.color.muted}" stroke-opacity="${THEME.opacity.grid}" stroke-width="${THEME.stroke.hairline}" />`,
      );
    }
    if (!showLabels) {
      parts.push(
        text({
          x: plotL - 8,
          y: y(tick) + THEME.font.tick * 0.36,
          content: format(tick),
          size: THEME.font.tick,
          color: THEME.color.muted,
          anchor: "end",
        }),
      );
    }
  }
  parts.push(
    `<line x1="${n(plotL)}" y1="${n(yBase) + 0.5}" x2="${n(plotR)}" y2="${n(yBase) + 0.5}" stroke="${THEME.color.muted}" stroke-opacity="${THEME.opacity.axis}" stroke-width="${THEME.stroke.hairline}" />`,
  );

  // With many narrow bars, label only what fits: the highlighted and tallest bar.
  const widestLabel = Math.max(
    ...totals.map((t) => textWidth(format(t), THEME.font.tick)),
  );
  const labelEvery =
    (spec.labelMode ?? "auto") === "auto" && widestLabel + 6 <= bandW;
  const labelHighlight = spec.labelMode !== "max";
  const widestX = Math.max(
    ...items.map((i) => textWidth(i.label, THEME.font.label)),
  );
  const xEvery = Math.max(1, Math.ceil((widestX + 8) / bandW));
  const tallest = totals.indexOf(Math.max(...totals));

  // The dashed reference line sits behind the bars; its label is a legend key
  // in the top-right corner, clear of every value label.
  if (
    spec.threshold &&
    spec.threshold.value >= lo &&
    spec.threshold.value <= hi
  ) {
    const ty = Math.round(y(spec.threshold.value)) + 0.5;
    const color = spec.threshold.color ?? THEME.color.muted;
    parts.push(
      `<line x1="${n(plotL)}" y1="${ty}" x2="${n(plotR)}" y2="${ty}" stroke="${color}" stroke-opacity="0.55" stroke-width="${THEME.stroke.hairline}" stroke-dasharray="3 4" />`,
    );
    if (spec.threshold.label) {
      const w = textWidth(spec.threshold.label, THEME.font.label);
      parts.push(
        `<line x1="${n(plotR - w - 24)}" y1="15.5" x2="${n(plotR - w - 8)}" y2="15.5" stroke="${color}" stroke-opacity="0.55" stroke-width="${THEME.stroke.hairline}" stroke-dasharray="3 4" />`,
        text({
          x: plotR,
          y: 20,
          content: spec.threshold.label,
          size: THEME.font.label,
          color: THEME.color.muted,
          weight: 500,
          anchor: "end",
        }),
      );
    }
  }

  items.forEach((item, i) => {
    const total = totals[i];
    const cx = (band(i) ?? 0) + band.bandwidth() / 2;
    const x = cx - barW / 2;
    const isHighlight = highlight === undefined || highlight === i;
    const strength = isHighlight || spec.dim === false ? 1 : THEME.opacity.dim;
    const yEnd = y(total);

    if (Math.abs(yBase - yEnd) >= 1) {
      const d = barPath({ x, width: barW, yBase, yEnd, radius: 6 });
      if (item.segments) {
        const clipId = `bar-clip-${i}`;
        defs.set(
          clipId,
          `<clipPath id="${clipId}"><path d="${d}" /></clipPath>`,
        );
        let cursor = yBase;
        const stack = item.segments
          .filter((s) => isFiniteNumber(s.value) && s.value !== 0)
          .map((s) => {
            const next = cursor + (y(s.value) - yBase);
            const rect = `<rect x="${n(x)}" y="${n(Math.min(cursor, next))}" width="${n(barW)}" height="${n(Math.abs(cursor - next))}" fill="${s.color}" fill-opacity="${strength}" />`;
            cursor = next;
            return rect;
          })
          .join("");
        parts.push(`<g clip-path="url(#${clipId})">${stack}</g>`);
      } else {
        const color = item.color ?? baseColor;
        const gradient = fadeGradient({
          color,
          from: 0.95 * strength,
          to: 0.6 * strength,
          direction: total >= 0 ? "down" : "up",
        });
        defs.set(gradient.id, gradient.def);
        parts.push(`<path d="${d}" fill="url(#${gradient.id})" />`);
      }
    }

    if (
      showLabels &&
      (labelEvery ||
        (labelHighlight && isHighlight && highlight !== undefined) ||
        i === tallest)
    ) {
      const content =
        isFiniteNumber(item.value) || item.segments ? format(total) : "—";
      const half = textWidth(content, THEME.font.tick + 1) / 2;
      // A label the threshold line would strike through moves inside its bar.
      const struck =
        spec.threshold !== undefined &&
        total > 0 &&
        Math.abs(y(spec.threshold.value) - (yEnd - 12)) < 9 &&
        yBase - yEnd > 28;
      parts.push(
        text({
          x: clamp(cx, half + 4, width - half - 4),
          y: struck ? yEnd + 18 : total >= 0 ? yEnd - 7 : yEnd + 16,
          content,
          size: THEME.font.tick + 1,
          color:
            isHighlight && highlight !== undefined
              ? THEME.color.text
              : THEME.color.muted,
          weight: isHighlight && highlight !== undefined ? 600 : 400,
        }),
      );
    }

    const isLast = i === items.length - 1;
    const regular =
      i % xEvery === 0 && (items.length - 1 - i >= xEvery || isLast);
    if (regular || isLast || highlight === i) {
      const marked = highlight === i;
      parts.push(
        text({
          x: cx,
          y: height - (twoLineAxis ? 24 : 9),
          content: item.label,
          size: THEME.font.label,
          color: marked ? THEME.color.text : THEME.color.muted,
          weight: marked ? 600 : 400,
        }),
      );
      if (item.sublabel) {
        parts.push(
          text({
            x: cx,
            y: height - 9,
            content: item.sublabel,
            size: THEME.font.label,
            color: marked ? THEME.color.text : THEME.color.muted,
            weight: marked ? 600 : 400,
            opacity: marked ? 1 : 0.8,
          }),
        );
      }
    }
  });

  return svgDocument(
    width,
    height,
    `${defs.size > 0 ? `<defs>${[...defs.values()].join("")}</defs>` : ""}${parts.join("")}`,
  );
}

// Ranked rows: label and value on one line, a thin rounded bar underneath.
function horizontalBars(spec: BarChartSpec, opts: Size | undefined): string {
  const { items } = spec;
  const width = opts?.width ?? HERO_COL_WIDTH;
  const rowH = 36;
  const height = opts?.height ?? items.length * rowH + 12;
  const format = spec.format ?? formatNumber;
  const padX = THEME.pad.x;
  const trackW = width - padX * 2;
  const rows = (height - 12) / items.length;
  const totals = items.map(totalOf);
  const max = Math.max(...totals, 1e-9);

  const defs = new Map<string, string>();
  const body = items
    .map((item, i) => {
      const total = totals[i];
      const color = item.color ?? spec.color ?? THEME.color.accent;
      const gradient = fadeGradient({
        color,
        from: 0.55,
        to: 1,
        direction: "right",
      });
      defs.set(gradient.id, gradient.def);
      const top = 6 + rows * i;
      const barY = top + 22;
      const fillW = total > 0 ? Math.max(6, (trackW * total) / max) : 0;
      return [
        text({
          x: padX,
          y: top + 14,
          content: item.label,
          size: THEME.font.value,
          color: THEME.color.text,
          weight: 500,
          anchor: "start",
        }),
        text({
          x: width - padX,
          y: top + 14,
          content:
            isFiniteNumber(item.value) || item.segments ? format(total) : "—",
          size: THEME.font.value,
          color: THEME.color.muted,
          anchor: "end",
        }),
        `<rect x="${padX}" y="${n(barY)}" width="${trackW}" height="6" rx="3" fill="${THEME.color.muted}" fill-opacity="${THEME.opacity.track}" />`,
        fillW > 0
          ? `<rect x="${padX}" y="${n(barY)}" width="${n(fillW)}" height="6" rx="3" fill="url(#${gradient.id})" />`
          : "",
      ].join("");
    })
    .join("");

  return svgDocument(
    width,
    height,
    `<defs>${[...defs.values()].join("")}</defs>${body}`,
  );
}

export function barChart(spec: BarChartSpec, opts?: Size): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 190;
  if (spec.items.length === 0)
    return emptyChart({ width, height: Math.min(height, 80) });
  return spec.orientation === "horizontal"
    ? horizontalBars(spec, opts)
    : verticalBars(spec, opts);
}

// ─── Threshold bar (single labeled horizontal bar) ─────────────────────────

export interface ThresholdBarSpec {
  label: string;
  percent: number; // 0-100, position of the fill
  valueText: string; // right-aligned value, e.g. "86% · 348 cycles"
  invert?: boolean; // high is good (health) instead of high is bad (quota)
}

export function thresholdBar(spec: ThresholdBarSpec, opts?: Size): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 50;
  const padX = THEME.pad.x;
  const trackW = width - padX * 2;
  const percent = clamp(
    isFiniteNumber(spec.percent) ? spec.percent : 0,
    0,
    100,
  );
  const color = thresholdColor(percent, { invert: spec.invert });
  const gradient = fadeGradient({
    color,
    from: 0.6,
    to: 1,
    direction: "right",
  });
  const fillW = Math.max(percent > 0 ? 8 : 0, (trackW * percent) / 100);
  const barY = height - 20;

  const body = `<defs>${gradient.def}</defs>${text({
    x: padX,
    y: 20,
    content: spec.label,
    size: THEME.font.title,
    color: THEME.color.text,
    weight: 600,
    anchor: "start",
  })}${text({
    x: width - padX,
    y: 20,
    content: spec.valueText,
    size: THEME.font.value,
    color: THEME.color.muted,
    anchor: "end",
  })}<rect x="${padX}" y="${barY}" width="${trackW}" height="8" rx="4" fill="${THEME.color.muted}" fill-opacity="${THEME.opacity.track}" />${
    fillW > 0
      ? `<rect x="${padX}" y="${barY}" width="${n(fillW)}" height="8" rx="4" fill="url(#${gradient.id})" />`
      : ""
  }`;

  return svgDocument(width, height, body);
}
