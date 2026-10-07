// Gauges and glyphs: rings (d3 `arc` with rounded caps), the menu-bar ring,
// battery and signal glyphs, the hub `tile` and `heroColumns` composition.
// Same theme as the charts so every hero reads as one family.

import { arc } from "d3-shape";
import {
  HERO_COL_WIDTH,
  RaycastColor,
  Size,
  THEME,
  clamp,
  fadeGradient,
  isFiniteNumber,
  n,
  svgDocument,
  text,
  textWidth,
  thresholdColor,
} from "./core";
import { SparklineSpec, sparklineMarkup } from "./series";

const TAU = Math.PI * 2;

// Track + a value arc with round caps. `arc` paths are centred on the origin,
// so the arc is translated into place.
function ringMarkup(opts: {
  cx: number;
  cy: number;
  radius: number;
  thickness: number;
  percent: number;
  color: RaycastColor;
  trackOpacity?: number;
}): string {
  const { cx, cy, radius, thickness, percent, color } = opts;
  const track = `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(radius)}" fill="none" stroke="${THEME.color.muted}" stroke-opacity="${opts.trackOpacity ?? THEME.opacity.track}" stroke-width="${n(thickness)}" />`;
  if (percent <= 0) return track;
  const d = arc()
    .cornerRadius(thickness / 2)
    .digits(1)({
    innerRadius: radius - thickness / 2,
    outerRadius: radius + thickness / 2,
    startAngle: 0,
    endAngle: (TAU * percent) / 100,
  });
  return `${track}<path d="${d}" transform="translate(${n(cx)} ${n(cy)})" fill="${color}" />`;
}

// ─── Ring gauges ────────────────────────────────────────────────────────────

export interface RingGaugeSpec {
  percent: number; // arc fill, 0-100
  label: string; // above the ring, e.g. "5h" or "Download"
  sublabel?: string; // below the ring, e.g. "resets in 2h 14m" or "Mbps"
  valueText?: string; // overrides the `${percent}%` centre text — e.g. a raw Mbps number
  color?: RaycastColor; // defaults to thresholdColor(percent)
  invert?: boolean; // high is good
  lowBoundary?: number; // thresholdColor override — see thresholdColor()
  highBoundary?: number;
}

// N gauges laid out evenly across one canvas — Claude Usage's quota rings,
// Speed Test's download/upload, Van Power's battery/solar.
export function ringGaugeRow(gauges: RingGaugeSpec[], opts?: Size): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 190;
  const cellWidth = width / Math.max(gauges.length, 1);
  const labelY = 20;
  const sublabelY = height - 10;
  const ringTop = labelY + 14;
  const ringBottom = sublabelY - 20;
  const radius = Math.min(cellWidth * 0.3, (ringBottom - ringTop) / 2);
  const thickness = clamp(radius * 0.17, 8, 14);
  const ringRadius = radius - thickness / 2;
  const cy = ringTop + radius;

  const cells = gauges
    .map((g, i) => {
      const cx = cellWidth * i + cellWidth / 2;
      const percent = clamp(isFiniteNumber(g.percent) ? g.percent : 0, 0, 100);
      const color =
        g.color ??
        thresholdColor(percent, {
          invert: g.invert,
          lowBoundary: g.lowBoundary,
          highBoundary: g.highBoundary,
        });
      const centerText = g.valueText ?? `${Math.round(percent)}%`;
      // Fit the headline inside the ring's hole, never below the 20pt floor.
      const hole = (ringRadius - thickness / 2) * 2 * 0.74;
      const size = clamp(
        Math.min(radius * 0.62, hole / textWidth(centerText, 1)),
        20,
        radius,
      );
      return [
        ringMarkup({ cx, cy, radius: ringRadius, thickness, percent, color }),
        text({
          x: cx,
          y: cy + size * 0.35,
          content: centerText,
          size,
          color: THEME.color.text,
          weight: 700,
          role: "primary",
        }),
        text({
          x: cx,
          y: labelY,
          content: g.label,
          size: THEME.font.title,
          color: THEME.color.text,
          weight: 600,
        }),
        g.sublabel
          ? text({
              x: cx,
              y: sublabelY,
              content: g.sublabel,
              size: THEME.font.label,
              color: THEME.color.muted,
            })
          : "",
      ].join("");
    })
    .join("");

  return svgDocument(width, height, cells);
}

// One gauge on its own canvas.
export function ring(spec: RingGaugeSpec, opts?: Size): string {
  return ringGaugeRow([spec], opts);
}

// ─── Menu-bar ring (small, no text — reads only as a filled arc at 18pt) ───

export interface MenuBarRingSpec {
  percent: number; // 0-100
  color?: RaycastColor; // defaults to thresholdColor(percent)
  invert?: boolean;
}

// `ExtensionMenuBarImage.swift` fits whatever this returns into an 18×18pt
// `NSStatusItem` glyph (vector, so any canvas works — 64 is a comfortable
// stroke unit) — no text, nothing reads at that size. A dim full track plus the
// coloured round-capped arc so it still reads as "a gauge", not a dot.
export function menuBarRing(spec: MenuBarRingSpec): string {
  const size = 64;
  const percent = clamp(
    isFiniteNumber(spec.percent) ? spec.percent : 0,
    0,
    100,
  );
  const color = spec.color ?? thresholdColor(percent, { invert: spec.invert });
  const thickness = size * 0.22;
  return svgDocument(
    size,
    size,
    ringMarkup({
      cx: size / 2,
      cy: size / 2,
      radius: size * 0.36,
      thickness,
      percent,
      color,
      trackOpacity: 0.3,
    }),
  );
}

// ─── Threshold-coloured battery glyph ──────────────────────────────────────

export interface BatteryGlyphSpec {
  percent: number;
  limitPercent?: number; // marker, e.g. the batt charge cap
  charging?: boolean;
  wattsLabel?: string; // e.g. "12 W" — shown under the percent
}

export function batteryGlyph(spec: BatteryGlyphSpec, opts?: Size): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 170;
  const percent = clamp(
    isFiniteNumber(spec.percent) ? spec.percent : 0,
    0,
    100,
  );
  const color = thresholdColor(percent, { invert: true });
  const bodyH = Math.min(height * 0.38, 64);
  const bodyW = Math.min(width * 0.62, bodyH * 3.4);
  const hasLimit = spec.limitPercent !== undefined;
  // Space for the limit label and the watts line is always reserved, so
  // glyphs side by side in a row line up whether or not they carry either.
  const contentH = bodyH + 14 + 34 + 20 + 18;
  const bodyY = (height - contentH) / 2 + 18;
  const bodyX = (width - bodyW) / 2 - 4;
  const inset = 5;
  const fillMax = bodyW - inset * 2;
  const fillW = (fillMax * percent) / 100;
  const gradient = fadeGradient({
    color,
    from: 0.6,
    to: 1,
    direction: "right",
  });
  const cx = bodyX + bodyW / 2;

  const limit = hasLimit
    ? (() => {
        const x =
          bodyX +
          inset +
          (fillMax * clamp(spec.limitPercent ?? 0, 0, 100)) / 100;
        return `<line x1="${n(x)}" y1="${n(bodyY - 5)}" x2="${n(x)}" y2="${n(bodyY + bodyH + 5)}" stroke="${THEME.color.text}" stroke-opacity="0.8" stroke-width="1.5" stroke-linecap="round" />${text(
          {
            x,
            y: bodyY - 10,
            content: `${Math.round(spec.limitPercent ?? 0)}% limit`,
            size: THEME.font.tick,
            color: THEME.color.muted,
          },
        )}`;
      })()
    : "";

  const boltH = bodyH * 0.55;
  const bolt = spec.charging
    ? `<path d="M${n(cx + boltH * 0.12)},${n(bodyY + bodyH / 2 - boltH / 2)} L${n(cx - boltH * 0.3)},${n(bodyY + bodyH / 2 + boltH * 0.1)} H${n(cx - boltH * 0.02)} L${n(cx - boltH * 0.12)},${n(bodyY + bodyH / 2 + boltH / 2)} L${n(cx + boltH * 0.3)},${n(bodyY + bodyH / 2 - boltH * 0.1)} H${n(cx + boltH * 0.02)} Z" fill="${THEME.color.text}" fill-opacity="0.92" />`
    : "";

  const textY = bodyY + bodyH + 14 + 26;
  const body = `<defs>${gradient.def}</defs>
    <rect x="${n(bodyX)}" y="${n(bodyY)}" width="${n(bodyW)}" height="${n(bodyH)}" rx="${n(bodyH * 0.2)}" fill="none" stroke="${THEME.color.muted}" stroke-opacity="0.7" stroke-width="2.5" />
    <rect x="${n(bodyX + bodyW + 3)}" y="${n(bodyY + bodyH * 0.32)}" width="5" height="${n(bodyH * 0.36)}" rx="2.5" fill="${THEME.color.muted}" fill-opacity="0.7" />
    ${fillW > 0 ? `<rect x="${n(bodyX + inset)}" y="${n(bodyY + inset)}" width="${n(Math.max(fillW, 4))}" height="${n(bodyH - inset * 2)}" rx="${n(bodyH * 0.12)}" fill="url(#${gradient.id})" />` : ""}
    ${limit}
    ${bolt}
    ${text({ x: cx, y: textY, content: `${Math.round(percent)}%`, size: 30, color: THEME.color.text, weight: 700, role: "primary" })}
    ${spec.wattsLabel ? text({ x: cx, y: textY + 20, content: spec.wattsLabel, size: THEME.font.value, color: THEME.color.muted }) : ""}`;

  return svgDocument(width, height, body);
}

// ─── Signal bars ────────────────────────────────────────────────────────────

export interface SignalBarsSpec {
  percent: number; // 0-100
  bars?: number; // default 5
  label?: string; // e.g. "4G+"
}

export function signalBars(spec: SignalBarsSpec, opts?: Size): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 170;
  const barCount = spec.bars ?? 5;
  const percent = clamp(
    isFiniteNumber(spec.percent) ? spec.percent : 0,
    0,
    100,
  );
  const filled = Math.max(1, Math.round((percent / 100) * barCount));
  const color = thresholdColor(percent, { invert: true });
  const maxBarHeight = Math.min(height * 0.42, 72);
  const contentH = maxBarHeight + (spec.label ? 36 : 0);
  const baseY = (height - contentH) / 2 + maxBarHeight;
  const barWidth = Math.min(maxBarHeight * 0.26, width / (barCount * 1.8));
  const gap = barWidth * 0.55;
  const groupWidth = barWidth * barCount + gap * (barCount - 1);
  const groupX = (width - groupWidth) / 2;

  const bars = Array.from({ length: barCount }, (_, i) => {
    const h = maxBarHeight * (0.28 + 0.72 * ((i + 1) / barCount));
    const on = i < filled;
    return `<rect x="${n(groupX + i * (barWidth + gap))}" y="${n(baseY - h)}" width="${n(barWidth)}" height="${n(h)}" rx="${n(barWidth * 0.35)}" fill="${on ? color : THEME.color.muted}" fill-opacity="${on ? 1 : THEME.opacity.track}" />`;
  }).join("");

  const label = spec.label
    ? text({
        x: width / 2,
        y: baseY + 28,
        content: spec.label,
        size: 17,
        color: THEME.color.text,
        weight: 600,
      })
    : "";

  return svgDocument(width, height, bars + label);
}

// ─── Hub tile (icon + name + one-line status, optional trend) ──────────────

export interface TileSpec {
  glyph: string; // one or two characters — fallback when no icon markup
  name: string;
  status: string; // one line, e.g. "3 overdue" or "…" while loading
  color?: RaycastColor;
  // Inner markup of a 512×512 command icon (assets/src/*.svg minus the outer
  // <svg>), drawn instead of the glyph so tiles match the launcher.
  iconMarkup?: string;
  trend?: SparklineSpec["values"]; // tiny sparkline under the status
}

// Wide 16:9 tile — icon left, name + live status right. Three columns of these
// fit the hub's commands in short rows.
export function tile(spec: TileSpec, opts?: Size): string {
  const width = opts?.width ?? 480;
  const height = opts?.height ?? 270;
  const color = spec.color ?? THEME.color.accent;
  const hasTrend = (spec.trend?.length ?? 0) > 1;
  const iconSize = height * 0.5;
  const iconX = height * 0.14;
  const iconY = hasTrend ? height * 0.2 : (height - iconSize) / 2;
  const textX = iconX + iconSize + height * 0.12;
  const gradient = fadeGradient({ color, from: 0.15, to: 0.04 });

  const icon = spec.iconMarkup
    ? `<g transform="translate(${n(iconX)} ${n(iconY)}) scale(${iconSize / 512})">${spec.iconMarkup}</g>`
    : `<rect x="${n(iconX)}" y="${n(iconY)}" width="${n(iconSize)}" height="${n(iconSize)}" rx="${n(iconSize * 0.22)}" fill="${color}" />${text(
        {
          x: iconX + iconSize / 2,
          y: iconY + iconSize * 0.66,
          content: spec.glyph,
          size: iconSize * 0.5,
          color: THEME.color.text,
          weight: 700,
        },
      )}`;

  const nameY = hasTrend ? height * 0.36 : height * 0.46;
  const statusY = hasTrend ? height * 0.54 : height * 0.66;
  const trend = hasTrend
    ? sparklineMarkup(
        { values: spec.trend ?? [], color },
        {
          x: textX - height * 0.02,
          y: height * 0.6,
          width: width - textX - height * 0.08,
          height: height * 0.28,
        },
      )
    : "";

  const body = `<defs>${gradient.def}</defs>
    <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${n(height * 0.1)}" fill="url(#${gradient.id})" stroke="${color}" stroke-opacity="0.28" stroke-width="1" />
    ${icon}
    ${text({ x: textX, y: nameY, content: spec.name, size: height * 0.14, color: THEME.color.text, weight: 600, anchor: "start" })}
    ${text({ x: textX, y: statusY, content: spec.status, size: height * 0.105, color: THEME.color.muted, anchor: "start" })}
    ${trend}`;

  return svgDocument(width, height, body);
}

// ─── Hero row (existing hero SVGs placed side by side) ─────────────────────

interface SvgBody {
  width: number;
  height: number;
  body: string;
}

// Splits a `svgDocument()`-produced string back into its declared size and
// inner markup — lets `heroColumns()` re-place an existing hero as one column
// of a wider composite instead of duplicating its drawing code.
function splitSvgDocument(svg: string): SvgBody {
  const match = svg.match(
    /<svg[^>]*\swidth="(\d+(?:\.\d+)?)"[^>]*\sheight="(\d+(?:\.\d+)?)"[^>]*>([\s\S]*)<\/svg>$/,
  );
  if (!match) throw new Error("heroColumns: not a svgDocument() output");
  return { width: Number(match[1]), height: Number(match[2]), body: match[3] };
}

// Places pre-rendered hero SVGs side by side in one row — netgear's
// signal/radio-quality/battery trio. Callers build each column at
// `colWidth = width / columns.length`; font sizes are fixed points, so
// narrowing a column only changes layout, never legibility. Gradient ids are
// deterministic per definition, so shared ids across columns are identical.
export function heroColumns(columns: string[], opts?: Size): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const colWidth = width / columns.length;
  const parts = columns.map(splitSvgDocument);
  const height = opts?.height ?? Math.max(...parts.map((p) => p.height));

  const groups = parts
    .map((part, i) => {
      const x = colWidth * i + (colWidth - part.width) / 2;
      const y = (height - part.height) / 2;
      return `<g transform="translate(${n(x)} ${n(y)})">${part.body}</g>`;
    })
    .join("");

  return svgDocument(width, height, groups);
}

// Stacks pre-rendered heroes vertically in one image, centred, `gap` apart —
// two charts that share an x axis (and day/night bands) without the markdown
// paragraph gap between them.
export function heroRows(
  rows: string[],
  opts?: Size & { gap?: number },
): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const gap = opts?.gap ?? 0;
  const parts = rows.map(splitSvgDocument);
  let y = 0;
  const groups = parts
    .map((part) => {
      const x = (width - part.width) / 2;
      const group = `<g transform="translate(${n(x)} ${n(y)})">${part.body}</g>`;
      y += part.height + gap;
      return group;
    })
    .join("");
  return svgDocument(width, opts?.height ?? y - gap, groups);
}
