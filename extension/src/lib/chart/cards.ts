// The "headline numbers" layer of a Detail, in two pieces that share one look —
// no filled boxes, only hairlines, so they sit on Tinycast's translucent window
// in both appearances (tokens only):
//   - `statCards`: a strip of label / big value + unit / sub cells divided by
//     hairlines; `size: "compact"` is the one-line label-over-value variant.
//   - `statusPanel`: two or three big headline columns, each with an optional
//     horizontal gauge (battery cell or thin bar) and one sub line.
// Long-tail reference fields stay a markdown table. Same theme as the charts.

import {
  HERO_COL_WIDTH,
  RaycastColor,
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
} from "./core";
import { SparklineSpec, sparklineMarkup } from "./series";

export type StatTone = "good" | "warn" | "bad" | "neutral" | "accent";

export interface StatDelta {
  value: string; // preformatted, e.g. "1.2 A"
  direction: "up" | "down" | "flat";
  good?: boolean; // colours the delta green/red; omitted = muted
}

export interface StatCard {
  label: string;
  value?: string | number | null; // missing / NaN → "—"
  unit?: string;
  sub?: string;
  tone?: StatTone;
  trend?: SparklineSpec["values"];
  trendColor?: RaycastColor; // default: the tone colour, else accent
  delta?: StatDelta;
}

const DASH = "—";
const PAD = THEME.pad.x;
const HAIRLINE_OPACITY = 0.3; // × the 0.6 alpha of secondary text ≈ 18% net
const VALUE_SIZE = 24;
const VALUE_SIZE_MIN = 20; // a long value shrinks this far (the 20pt primary floor), then truncates
const COMPACT_VALUE_SIZE = 20;
const UNIT_SIZE = THEME.font.title;
const UNIT_GAP = 5;
const SPARK_WIDTH = 56;
const SPARK_HEIGHT = 30;
const ARROW = { up: "▲", down: "▼", flat: "●" } as const;
const TONE_COLOR: Record<StatTone, RaycastColor | null> = {
  good: THEME.color.good,
  warn: THEME.color.warn,
  bad: THEME.color.bad,
  accent: THEME.color.accent,
  neutral: null,
};

function defaultColumns(count: number): number {
  if (count <= 4) return Math.max(1, count);
  return count <= 6 ? 3 : 4;
}

// Shortens to fit `maxWidth` (by the rough advance-width estimate), ending in
// an ellipsis; never returns more than needed.
export function fitText(
  content: string,
  size: number,
  maxWidth: number,
): string {
  if (textWidth(content, size) <= maxWidth) return content;
  let end = content.length;
  while (end > 1 && textWidth(`${content.slice(0, end)}…`, size) > maxWidth) {
    end -= 1;
  }
  return `${content.slice(0, end).trimEnd()}…`;
}

// The big number's advance width: digits and signs are tabular (~0.6 em),
// the decimal point narrow — tighter than textWidth's all-purpose estimate, so
// the unit sits right against the value instead of floating off it.
function valueWidth(content: string, size: number): number {
  let em = 0;
  for (const ch of content) {
    if (/[0-9+−-]/.test(ch)) em += 0.59;
    else if (/[.,]/.test(ch)) em += 0.27;
    else em += textWidth(ch, 1);
  }
  return em * size;
}

function valueText(value: StatCard["value"]): string | null {
  if (typeof value === "number") {
    return isFiniteNumber(value) ? formatNumber(value) : null;
  }
  return value ? value : null;
}

export interface StatCardsSpec {
  cards: StatCard[];
  columns?: number; // 1–4 (compact: 1–6); default: all cards up to 4, else 3 (5–6) or 4 (7–8)
  width?: number; // canvas width, default HERO_COL_WIDTH
  // "compact": label over a 20 pt value on one short row — no sub line, no
  // sparkline — for the quiet secondary metrics under a panel.
  size?: "standard" | "compact";
}

const hairline = (x1: number, y1: number, x2: number, y2: number): string =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${THEME.color.muted}" stroke-opacity="${HAIRLINE_OPACITY}" stroke-width="${THEME.stroke.hairline}" />`;

// Value + unit on one baseline. The value shrinks 24 → 20 pt before it
// truncates (so a word like "Discharging" still fits a quarter-width cell);
// the unit sits against whatever was drawn.
function valueRun(opts: {
  x: number;
  y: number;
  value: string | null;
  unit: string;
  room: number;
  size: number;
  minSize: number;
}): { markup: string; width: number } {
  const { x, y, value, room, size, minSize } = opts;
  const unit = value !== null ? opts.unit : "";
  const gap = unit === "%" ? 2 : UNIT_GAP;
  const unitWidth = unit ? textWidth(unit, UNIT_SIZE) + gap : 0;
  const available = room - unitWidth;
  const content = value ?? DASH;
  let valueSize = size;
  while (valueSize > minSize && valueWidth(content, valueSize) > available) {
    valueSize -= 2;
  }
  const fits = valueWidth(content, valueSize) <= available;
  const shown = fits ? content : fitText(content, valueSize, available);
  const shownWidth = fits
    ? valueWidth(shown, valueSize)
    : textWidth(shown, valueSize);
  const parts = [
    text({
      x,
      y,
      content: shown,
      size: valueSize,
      color: value !== null ? THEME.color.text : THEME.color.muted,
      weight: 600,
      anchor: "start",
      role: "primary",
    }),
  ];
  if (unit) {
    parts.push(
      text({
        x: x + shownWidth + gap,
        y,
        content: unit,
        size: UNIT_SIZE,
        color: THEME.color.muted,
        weight: 500,
        anchor: "start",
      }),
    );
  }
  return { markup: parts.join(""), width: shownWidth + unitWidth };
}

function toneDot(tone: RaycastColor | null, x: number, y: number): string {
  return tone
    ? `<circle cx="${n(x)}" cy="${n(y)}" r="3" fill="${tone}" />`
    : "";
}

function cellMarkup(
  card: StatCard,
  box: { x: number; y: number; width: number; height: number },
  opts: { compact: boolean; hasSub: boolean },
): string {
  const { x, y, width } = box;
  const { compact, hasSub } = opts;
  const left = x + PAD;
  const inner = width - PAD * 2;
  const tone = TONE_COLOR[card.tone ?? "neutral"];
  const value = valueText(card.value);
  const hasTrend = !compact && (card.trend?.length ?? 0) > 1;
  const parts: string[] = [];

  // Label row: caps label, tone dot after it, delta pushed right.
  const labelSize = THEME.font.tick;
  const delta = card.delta;
  const deltaText = delta ? `${ARROW[delta.direction]} ${delta.value}` : "";
  const deltaWidth = delta ? textWidth(deltaText, labelSize) : 0;
  const dotRoom = tone ? 12 : 0;
  const label = fitText(
    card.label.toUpperCase(),
    labelSize * 1.1, // caps run wider than the estimate
    inner - dotRoom - (delta ? deltaWidth + 16 : 0),
  );
  const labelY = y + 18;
  parts.push(
    text({
      x: left,
      y: labelY,
      content: label,
      size: labelSize,
      color: THEME.color.muted,
      weight: 600,
      anchor: "start",
    }),
    toneDot(tone, left + textWidth(label, labelSize * 1.1) + 8, labelY - 4),
  );
  if (delta) {
    const deltaColor =
      delta.good === undefined
        ? THEME.color.muted
        : delta.good
          ? THEME.color.good
          : THEME.color.bad;
    parts.push(
      text({
        x: x + width - PAD,
        y: labelY,
        content: deltaText,
        size: labelSize,
        color: deltaColor,
        weight: 600,
        anchor: "end",
      }),
    );
  }

  // Value row: big number + smaller unit; a sparkline sits to its right.
  const valueY = y + (compact ? 43 : 50);
  const sparkReserve = hasTrend ? SPARK_WIDTH + 8 : 0;
  const run = valueRun({
    x: left,
    y: valueY,
    value,
    unit: card.unit ?? "",
    room: inner - sparkReserve,
    size: compact ? COMPACT_VALUE_SIZE : VALUE_SIZE,
    minSize: compact ? COMPACT_VALUE_SIZE : VALUE_SIZE_MIN,
  });
  parts.push(run.markup);
  if (hasTrend) {
    parts.push(
      sparklineMarkup(
        {
          values: card.trend ?? [],
          color: card.trendColor ?? tone ?? THEME.color.accent,
        },
        {
          x: x + width - PAD - SPARK_WIDTH,
          y: valueY - SPARK_HEIGHT + 2,
          width: SPARK_WIDTH,
          height: SPARK_HEIGHT,
        },
      ),
    );
  }

  if (!compact && hasSub && card.sub) {
    parts.push(
      text({
        x: left,
        y: y + 71,
        content: fitText(card.sub, THEME.font.tick, inner),
        size: THEME.font.tick,
        color: THEME.color.muted,
        anchor: "start",
      }),
    );
  }
  return parts.join("");
}

// A strip of KPI cells at the column width: hairlines above, below and
// between rows, short vertical hairlines between columns, no fills. Meant for
// ≤ 8 headline numbers — anything longer is a table.
export function statCards(spec: StatCardsSpec): string {
  const width = spec.width ?? HERO_COL_WIDTH;
  const compact = spec.size === "compact";
  const count = spec.cards.length;
  const rowHeight = compact ? 56 : spec.cards.some((c) => c.sub) ? 82 : 60;
  if (count === 0) {
    return emptyChart({ width, height: rowHeight, message: "No data yet" });
  }
  const columns = Math.min(
    compact ? 6 : 4,
    Math.max(1, Math.floor(spec.columns ?? defaultColumns(count))),
  );
  const rows = Math.max(1, Math.ceil(count / columns));
  const cellWidth = width / columns;
  const height = rows * rowHeight;
  const hasSub = spec.cards.some((c) => c.sub);

  const parts: string[] = [hairline(0, 0.5, width, 0.5)];
  for (let r = 1; r <= rows; r++) {
    parts.push(hairline(0, r * rowHeight - 0.5, width, r * rowHeight - 0.5));
  }
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(columns, count - r * columns);
    for (let c = 1; c < inRow; c++) {
      parts.push(
        hairline(
          c * cellWidth,
          r * rowHeight + 12,
          c * cellWidth,
          (r + 1) * rowHeight - 12,
        ),
      );
    }
  }
  spec.cards.forEach((card, i) => {
    parts.push(
      cellMarkup(
        card,
        {
          x: (i % columns) * cellWidth,
          y: Math.floor(i / columns) * rowHeight,
          width: cellWidth,
          height: rowHeight,
        },
        { compact, hasSub },
      ),
    );
  });
  return svgDocument(width, height, parts.join(""));
}

// ─── Status panel ───────────────────────────────────────────────────────────

export interface PanelColumn {
  label: string;
  value?: string | number | null; // the one big number; missing → "—"
  unit?: string;
  sub?: string; // one muted line under the gauge
  percent?: number; // 0–100: draws the gauge when set
  color?: RaycastColor; // gauge fill; default accent
  marker?: number; // 0–100: a tick on the gauge (e.g. a charge limit)
  gauge?: "battery" | "bar"; // default "bar"
}

export interface StatusPanelSpec {
  columns: PanelColumn[]; // 1–3
  width?: number;
}

const PANEL_HEIGHT = 124;
const PANEL_VALUE_SIZE = 38;
const PANEL_VALUE_MIN = 26;

// Horizontal gauge: a thin rounded track, or a battery cell (outline, nub,
// inset fill) — both fill left to right, in a fading gradient of the colour.
function gaugeMarkup(opts: {
  x: number;
  y: number;
  width: number;
  percent: number;
  color: RaycastColor;
  kind: "battery" | "bar";
  marker?: number;
}): { markup: string; def: string } {
  const { x, y, width, color, kind } = opts;
  const percent = clamp(
    isFiniteNumber(opts.percent) ? opts.percent : 0,
    0,
    100,
  );
  const gradient = fadeGradient({
    color,
    from: 0.6,
    to: 1,
    direction: "right",
  });
  const parts: string[] = [];
  if (kind === "battery") {
    const h = 20;
    const nub = 4;
    const bodyW = width - nub - 2;
    parts.push(
      `<rect x="${n(x + 0.75)}" y="${n(y + 0.75)}" width="${n(bodyW - 1.5)}" height="${h - 1.5}" rx="5" fill="none" stroke="${THEME.color.muted}" stroke-opacity="0.55" stroke-width="1.5" />`,
      `<rect x="${n(x + bodyW + 2)}" y="${n(y + h / 2 - 4)}" width="${nub}" height="8" rx="2" fill="${THEME.color.muted}" fill-opacity="0.55" />`,
    );
    const fillW = ((bodyW - 6) * percent) / 100;
    if (fillW > 0) {
      parts.push(
        `<rect x="${n(x + 3)}" y="${n(y + 3)}" width="${n(Math.max(fillW, 4))}" height="${h - 6}" rx="3" fill="url(#${gradient.id})" />`,
      );
    }
    if (opts.marker !== undefined) {
      const mx = x + 3 + ((bodyW - 6) * clamp(opts.marker, 0, 100)) / 100;
      parts.push(
        `<line x1="${n(mx)}" y1="${n(y - 3)}" x2="${n(mx)}" y2="${n(y + h + 3)}" stroke="${THEME.color.text}" stroke-opacity="0.7" stroke-width="1.5" stroke-linecap="round" />`,
      );
    }
  } else {
    const h = 8;
    parts.push(
      `<rect x="${n(x)}" y="${n(y + 6)}" width="${n(width)}" height="${h}" rx="4" fill="${THEME.color.muted}" fill-opacity="${THEME.opacity.track}" />`,
    );
    const fillW = (width * percent) / 100;
    if (fillW > 0) {
      parts.push(
        `<rect x="${n(x)}" y="${n(y + 6)}" width="${n(Math.max(fillW, h))}" height="${h}" rx="4" fill="url(#${gradient.id})" />`,
      );
    }
    if (opts.marker !== undefined) {
      const mx = x + (width * clamp(opts.marker, 0, 100)) / 100;
      parts.push(
        `<line x1="${n(mx)}" y1="${n(y + 2)}" x2="${n(mx)}" y2="${n(y + 18)}" stroke="${THEME.color.text}" stroke-opacity="0.7" stroke-width="1.5" stroke-linecap="round" />`,
      );
    }
  }
  return { markup: parts.join(""), def: gradient.def };
}

// The compact replacement for a row of big rings: 1–3 headline columns — label,
// one big number, a horizontal gauge, one sub line — divided by hairlines.
export function statusPanel(spec: StatusPanelSpec): string {
  const width = spec.width ?? HERO_COL_WIDTH;
  const columns = spec.columns.slice(0, 3);
  if (columns.length === 0) {
    return emptyChart({ width, height: 64, message: "No data yet" });
  }
  const colWidth = width / columns.length;
  const defs = new Map<string, string>();
  const parts: string[] = [];

  columns.forEach((col, i) => {
    const x = i * colWidth;
    const left = x + PAD;
    const inner = colWidth - PAD * 2;
    if (i > 0) parts.push(hairline(x, 14, x, PANEL_HEIGHT - 14));
    parts.push(
      text({
        x: left,
        y: 24,
        content: fitText(col.label.toUpperCase(), THEME.font.tick * 1.1, inner),
        size: THEME.font.tick,
        color: THEME.color.muted,
        weight: 600,
        anchor: "start",
      }),
    );
    const run = valueRun({
      x: left,
      y: 66,
      value: valueText(col.value),
      unit: col.unit ?? "",
      room: inner,
      size: PANEL_VALUE_SIZE,
      minSize: PANEL_VALUE_MIN,
    });
    parts.push(run.markup);
    if (col.percent !== undefined) {
      const gauge = gaugeMarkup({
        x: left,
        y: 80,
        width: inner,
        percent: col.percent,
        color: col.color ?? THEME.color.accent,
        kind: col.gauge ?? "bar",
        marker: col.marker,
      });
      defs.set(gauge.def, gauge.def);
      parts.push(gauge.markup);
    }
    if (col.sub) {
      parts.push(
        text({
          x: left,
          y: 114,
          content: fitText(col.sub, THEME.font.label, inner),
          size: THEME.font.label,
          color: THEME.color.muted,
          anchor: "start",
        }),
      );
    }
  });
  return svgDocument(
    width,
    PANEL_HEIGHT,
    `${defs.size > 0 ? `<defs>${[...defs.values()].join("")}</defs>` : ""}${parts.join("")}`,
  );
}
