// Pure SVG toolkit for Tinycast hero/tile images — no dependencies. Every
// colour is a `raycast-*` name (never a hex literal): Tinycast's
// `ExtensionImage`/`ExtensionIconCache` rewrites those whole-word tokens to
// the live theme colour before decoding an inline `data:image/svg+xml`
// image, which is the only way these SVGs adapt to light/dark. See
// `.claude/skills/tinycast/SKILL.md` § Designing for Tinycast (beta/main).
//
// Target renderer: Tinycast **beta** (0.11.10-beta.x = upstream `main`),
// window 750×475 at `interfaceSize: standard` (verified against
// `Tinycast/DesignSystem/Theme.swift`'s `Size.panelWidth/panelHeight`).
// Unlike stable 0.11.3, main has **no 220pt image height cap** — a markdown
// image draws at its own intrinsic size (the SVG's own `width`/`height`
// attributes), or is fit into an explicit `?raycast-width=&raycast-height=`
// hint if the URL carries one (`ExtensionImageSize.swift`,
// `ExtensionMarkdownImage` in `ExtensionDetailView.swift`). `toDataUri()`
// always appends that hint, matching the SVG's own canvas exactly, so the
// render is pinned to a known point size rather than left to NSImage's
// reported intrinsic size — belt and suspenders, not strictly required.
//
// Every Detail command in this extension renders full-width (no
// `Detail.Metadata` sidebar — dropped once the hero images carry the
// numbers a sidebar used to; see `docs/architecture.md` § Metadata). That
// markdown pane is `panelWidth(750) − 2×Spacing.lg(10)` ≈ 730pt
// (`ExtensionDetailView.swift`'s `markdownPane`); `HERO_COL_WIDTH` below is
// a conservative round number under that, leaving slack for chrome this
// module didn't trace. Every hero's SVG canvas width should be ≤
// `HERO_COL_WIDTH` so it never upscales — `assertLegible()` below (and
// svg.test.ts's "Hero image legibility" block) enforce this and the ≥11pt
// (≥20pt for the one headline number) floor for every production hero.

import { Buffer } from "buffer";

// Conservative full-width markdown pane target (see header comment) — used
// by every Detail hero now that Detail.Metadata sidebars are dropped.
export const HERO_COL_WIDTH = 680;

// scale = min(1, columnWidth / svgWidth) — main never upscales an image
// past its intrinsic/hinted size, it only shrinks one that's too wide for
// the column. There's no height cap to fold in (unlike stable 0.11.3).
export function computeImageScale(colWidth: number, svgWidth: number): number {
  return Math.min(1, colWidth / svgWidth);
}

interface FontSizeEntry {
  size: number;
  role: "primary" | "label";
}

// Every `<text>` this module emits carries `data-role` right after
// `font-size` (see `text()` below) — this regex depends on that fixed
// attribute order.
function extractFontSizes(svg: string): FontSizeEntry[] {
  const re = /font-size="([0-9.]+)"[^>]*data-role="(primary|label)"/g;
  const entries: FontSizeEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(svg))) {
    entries.push({
      size: Number(match[1]),
      role: match[2] as "primary" | "label",
    });
  }
  return entries;
}

// Every text element must render ≥11pt; a `role: "primary"` element (the
// one headline number of a hero — a ring's percent, a gauge's Mbps) must
// render ≥20pt. Returns the violations rather than a boolean so a failing
// test can print exactly what's too small.
export function assertLegible(
  svg: string,
  colWidth: number,
  svgWidth: number,
): string[] {
  const scale = computeImageScale(colWidth, svgWidth);
  const violations: string[] = [];
  for (const { size, role } of extractFontSizes(svg)) {
    const rendered = size * scale;
    if (rendered < 11) {
      violations.push(
        `font-size ${size} (${role}) renders at ${rendered.toFixed(1)}pt < 11pt (scale ${scale.toFixed(3)})`,
      );
    }
    if (role === "primary" && rendered < 20) {
      violations.push(
        `primary font-size ${size} renders at ${rendered.toFixed(1)}pt < 20pt (scale ${scale.toFixed(3)})`,
      );
    }
  }
  return violations;
}

export const RAYCAST_COLOR = {
  primaryText: "raycast-primary-text",
  secondaryText: "raycast-secondary-text",
  red: "raycast-red",
  orange: "raycast-orange",
  yellow: "raycast-yellow",
  green: "raycast-green",
  blue: "raycast-blue",
  purple: "raycast-purple",
  magenta: "raycast-magenta",
} as const;

export type RaycastColor = (typeof RAYCAST_COLOR)[keyof typeof RAYCAST_COLOR];

const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// <50 green, <80 orange, ≥80 red — quota/battery-style "high is bad" reading
// by default; pass `invert: true` for "high is good" (e.g. signal quality).
// `lowBoundary`/`highBoundary` override the 50/80 split — radio quality uses
// 35/60, since LTE quality percentages rarely approach 80 even when good.
export function thresholdColor(
  percent: number,
  opts?: { invert?: boolean; lowBoundary?: number; highBoundary?: number },
): RaycastColor {
  const p = clamp(percent, 0, 100);
  const lowBoundary = opts?.lowBoundary ?? 50;
  const highBoundary = opts?.highBoundary ?? 80;
  const [low, mid, high] = opts?.invert
    ? [RAYCAST_COLOR.red, RAYCAST_COLOR.orange, RAYCAST_COLOR.green]
    : [RAYCAST_COLOR.green, RAYCAST_COLOR.orange, RAYCAST_COLOR.red];
  if (p < lowBoundary) return low;
  if (p < highBoundary) return mid;
  return high;
}

// Appends a `?raycast-width=&raycast-height=` hint matching the SVG's own
// declared size, read straight off the `<svg width="…" height="…">` root
// tag `svgDocument()` always emits — a single source of truth, so the hint
// can never drift from the canvas the shapes were actually laid out on.
// `ExtensionImageSize.swift` parses the hint from *after* the comma on a
// `data:` URL, so it's safe to append here unconditionally.
export function toDataUri(svg: string): string {
  const base64 = Buffer.from(svg, "utf8").toString("base64");
  const dims = svg.match(
    /<svg[^>]*\swidth="(\d+(?:\.\d+)?)"[^>]*\sheight="(\d+(?:\.\d+)?)"/,
  );
  const hint = dims
    ? `?raycast-width=${dims[1]}&raycast-height=${dims[2]}`
    : "";
  return `data:image/svg+xml;base64,${base64}${hint}`;
}

export function svgDocument(
  width: number,
  height: number,
  body: string,
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function text(
  x: number,
  y: number,
  content: string,
  opts: {
    size: number;
    color: string;
    weight?: number;
    anchor?: "start" | "middle" | "end";
    // "primary" = the one headline number of a hero (a ring's percent, a
    // gauge's Mbps) — held to a stricter ≥20pt floor by assertLegible().
    // Attribute order is fixed (font-size immediately before data-role) —
    // extractFontSizes() in this file depends on it.
    role?: "primary" | "label";
  },
): string {
  const anchor = opts.anchor ?? "middle";
  const role = opts.role ?? "label";
  return `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${opts.size}" data-role="${role}" font-weight="${opts.weight ?? 400}" fill="${opts.color}" text-anchor="${anchor}">${escapeXml(content)}</text>`;
}

// ─── Ring / arc gauge ───────────────────────────────────────────────────────

export interface RingGaugeSpec {
  percent: number; // arc fill, 0-100
  label: string; // centered above the ring, e.g. "5h" or "Download"
  sublabel?: string; // one line below the ring, e.g. "in 2h 14m" or "Mbps"
  valueText?: string; // overrides the default `${percent}%` center text — e.g. a raw Mbps number
  color?: RaycastColor; // defaults to thresholdColor(percent)
  invert?: boolean;
  lowBoundary?: number; // thresholdColor override — see thresholdColor()
  highBoundary?: number;
}

// N gauges laid out evenly across one wide canvas — the "hero" shape for
// Claude Usage's three quota rings and Speed Test's download/upload gauges.
// Label/sublabel sizes are fixed points (not width-relative) since the
// canvas width is already the target render width — see HERO_COL_WIDTH.
export function ringGaugeRow(
  gauges: RingGaugeSpec[],
  opts?: { width?: number; height?: number },
): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 220;
  const cellWidth = width / gauges.length;
  const labelY = 24;
  const sublabelY = height - 12;
  const ringTop = labelY + 14;
  const ringBottom = sublabelY - 24;
  const radius = Math.min(cellWidth * 0.3, (ringBottom - ringTop) / 2);
  const strokeWidth = radius * 0.22;
  const cy = ringTop + radius;

  const cells = gauges
    .map((g, i) => {
      const cx = cellWidth * i + cellWidth / 2;
      const percent = clamp(g.percent, 0, 100);
      const color =
        g.color ??
        thresholdColor(percent, {
          invert: g.invert,
          lowBoundary: g.lowBoundary,
          highBoundary: g.highBoundary,
        });
      const circumference = 2 * Math.PI * radius;
      const offset = circumference * (1 - percent / 100);
      const centerText = g.valueText ?? `${Math.round(percent)}%`;
      return `
        <g>
          <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${RAYCAST_COLOR.secondaryText}" stroke-opacity="0.25" stroke-width="${strokeWidth}" />
          <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${circumference} ${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})" />
          ${text(cx, cy + radius * 0.16, centerText, { size: radius * 0.62, color: RAYCAST_COLOR.primaryText, weight: 700, role: "primary" })}
          ${text(cx, labelY, g.label, { size: 22, color: RAYCAST_COLOR.primaryText, weight: 600 })}
          ${g.sublabel ? text(cx, sublabelY, g.sublabel, { size: 16, color: RAYCAST_COLOR.secondaryText }) : ""}
        </g>`;
    })
    .join("");

  return svgDocument(width, height, cells);
}

// ─── Threshold bar (single labeled horizontal bar) ─────────────────────────

export interface ThresholdBarSpec {
  label: string;
  percent: number; // 0-100, position of the fill
  valueText: string; // right-aligned value, e.g. "$4.20"
  invert?: boolean;
}

export function thresholdBar(
  spec: ThresholdBarSpec,
  opts?: { width?: number; height?: number },
): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 60;
  const padX = 10;
  const barY = height - 18;
  const barHeight = 10;
  const trackWidth = width - padX * 2;
  const percent = clamp(spec.percent, 0, 100);
  const color = thresholdColor(percent, { invert: spec.invert });
  const fillWidth = (trackWidth * percent) / 100;

  const body = `
    ${text(padX, 20, spec.label, { size: 20, color: RAYCAST_COLOR.primaryText, anchor: "start", weight: 600 })}
    ${text(width - padX, 20, spec.valueText, { size: 20, color: RAYCAST_COLOR.secondaryText, anchor: "end" })}
    <rect x="${padX}" y="${barY}" width="${trackWidth}" height="${barHeight}" rx="${barHeight / 2}" fill="${RAYCAST_COLOR.secondaryText}" fill-opacity="0.25" />
    <rect x="${padX}" y="${barY}" width="${fillWidth}" height="${barHeight}" rx="${barHeight / 2}" fill="${color}" />`;

  return svgDocument(width, height, body);
}

// ─── Horizontal bar chart (label + value per row) ──────────────────────────

export interface BarChartItem {
  label: string;
  value: number;
  color?: RaycastColor;
}

export function barChart(
  items: BarChartItem[],
  opts?: {
    width?: number;
    height?: number;
    formatValue?: (v: number) => string;
    color?: RaycastColor;
  },
): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 220;
  const formatValue = opts?.formatValue ?? ((v: number) => v.toFixed(2));
  const padX = 10;
  const rowHeight = height / Math.max(items.length, 1);
  const barHeight = Math.min(20, rowHeight * 0.45);
  const labelWidth = width * 0.3;
  const valueWidth = width * 0.12;
  const trackWidth = width - labelWidth - valueWidth - padX * 2;
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  // Floor, not just a cap: at most a handful of rows are ever passed in
  // (callers keep it to 5 lanes + "other"), so rowHeight-driven shrinkage
  // should never actually bite — this is a defensive backstop.
  const rowFontSize = Math.max(11, Math.min(18, rowHeight * 0.4));

  const rows = items
    .map((item, i) => {
      const cy = rowHeight * i + rowHeight / 2;
      const barY = cy - barHeight / 2;
      const barWidth = trackWidth * (item.value / max);
      const color = item.color ?? opts?.color ?? RAYCAST_COLOR.blue;
      return `
        ${text(padX + labelWidth - 12, cy + barHeight * 0.35, item.label, { size: rowFontSize, color: RAYCAST_COLOR.primaryText, anchor: "end" })}
        <rect x="${padX + labelWidth}" y="${barY}" width="${trackWidth}" height="${barHeight}" rx="${barHeight / 2}" fill="${RAYCAST_COLOR.secondaryText}" fill-opacity="0.2" />
        <rect x="${padX + labelWidth}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${barHeight / 2}" fill="${color}" />
        ${text(width - padX, cy + barHeight * 0.35, formatValue(item.value), { size: rowFontSize, color: RAYCAST_COLOR.secondaryText, anchor: "end" })}`;
    })
    .join("");

  return svgDocument(width, height, rows);
}

// ─── Sparkline (line + area, optional first/last labels) ──────────────────

export interface SparklineSpec {
  values: number[];
  formatValue?: (v: number) => string;
  color?: RaycastColor;
}

export function sparkline(
  spec: SparklineSpec,
  opts?: { width?: number; height?: number },
): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 160;
  const padTop = 30;
  const padBottom = 16;
  const padX = 24;
  const plotWidth = width - padX * 2;
  const plotHeight = height - padTop - padBottom;
  const values = spec.values.length > 0 ? spec.values : [0];
  const max = Math.max(...values, 1e-9);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const color = spec.color ?? RAYCAST_COLOR.blue;
  const formatValue = spec.formatValue ?? ((v: number) => v.toFixed(2));

  const stepX = values.length > 1 ? plotWidth / (values.length - 1) : plotWidth;
  const points = values.map((v, i) => {
    const x = padX + (values.length > 1 ? stepX * i : plotWidth / 2);
    const y = padTop + plotHeight - ((v - min) / range) * plotHeight;
    return { x, y };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${(padTop + plotHeight).toFixed(1)} L${points[0].x.toFixed(1)},${(padTop + plotHeight).toFixed(1)} Z`;

  const dots = points
    .map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${color}" />`)
    .join("");

  const firstLabel = text(points[0].x, padTop - 12, formatValue(values[0]), {
    size: 16,
    color: RAYCAST_COLOR.secondaryText,
    anchor: "start",
  });
  const lastValue = values[values.length - 1];
  const lastLabel = text(
    points[points.length - 1].x,
    padTop - 12,
    formatValue(lastValue),
    { size: 16, color: RAYCAST_COLOR.primaryText, anchor: "end", weight: 600 },
  );

  const body = `
    <path d="${areaPath}" fill="${color}" fill-opacity="0.15" stroke="none" />
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />
    ${dots}
    ${firstLabel}
    ${lastLabel}`;

  return svgDocument(width, height, body);
}

// ─── Battery glyph ──────────────────────────────────────────────────────────

export interface BatteryGlyphSpec {
  percent: number;
  limitPercent?: number; // marker line, e.g. the batt charge cap
  charging?: boolean;
  wattsLabel?: string; // e.g. "12 W" — shown under the glyph
}

export function batteryGlyph(
  spec: BatteryGlyphSpec,
  opts?: { width?: number; height?: number },
): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 180;
  const bodyWidth = width * 0.62;
  const bodyHeight = height * 0.42;
  const bodyX = (width - bodyWidth) / 2 - width * 0.02;
  const bodyY = height * 0.14;
  const capWidth = bodyWidth * 0.035;
  const capHeight = bodyHeight * 0.4;
  const percent = clamp(spec.percent, 0, 100);
  const color = thresholdColor(percent, { invert: true });
  const inset = 8;
  const fillMaxWidth = bodyWidth - inset * 2;
  const fillWidth = (fillMaxWidth * percent) / 100;

  const limitMarker =
    spec.limitPercent !== undefined
      ? (() => {
          const x = bodyX + inset + (fillMaxWidth * spec.limitPercent) / 100;
          return `<line x1="${x}" y1="${bodyY - 4}" x2="${x}" y2="${bodyY + bodyHeight + 4}" stroke="${RAYCAST_COLOR.primaryText}" stroke-width="2" stroke-dasharray="4 4" />`;
        })()
      : "";

  const bolt = spec.charging
    ? `<path d="M ${bodyX + bodyWidth * 0.46} ${bodyY + bodyHeight * 0.12} L ${bodyX + bodyWidth * 0.3} ${bodyY + bodyHeight * 0.58} L ${bodyX + bodyWidth * 0.44} ${bodyY + bodyHeight * 0.58} L ${bodyX + bodyWidth * 0.34} ${bodyY + bodyHeight * 0.92} L ${bodyX + bodyWidth * 0.6} ${bodyY + bodyHeight * 0.4} L ${bodyX + bodyWidth * 0.46} ${bodyY + bodyHeight * 0.4} Z" fill="${RAYCAST_COLOR.primaryText}" />`
    : "";

  const body = `
    <rect x="${bodyX}" y="${bodyY}" width="${bodyWidth}" height="${bodyHeight}" rx="${bodyHeight * 0.14}" fill="none" stroke="${RAYCAST_COLOR.primaryText}" stroke-width="4" />
    <rect x="${bodyX + bodyWidth}" y="${bodyY + (bodyHeight - capHeight) / 2}" width="${capWidth}" height="${capHeight}" rx="${capWidth * 0.4}" fill="${RAYCAST_COLOR.primaryText}" />
    <rect x="${bodyX + inset}" y="${bodyY + inset}" width="${fillWidth}" height="${bodyHeight - inset * 2}" rx="${(bodyHeight - inset * 2) * 0.18}" fill="${color}" />
    ${limitMarker}
    ${bolt}
    ${text(bodyX + bodyWidth / 2, bodyY + bodyHeight + 40, `${Math.round(percent)}%`, { size: 34, color: RAYCAST_COLOR.primaryText, weight: 700, role: "primary" })}
    ${spec.wattsLabel ? text(bodyX + bodyWidth / 2, bodyY + bodyHeight + 66, spec.wattsLabel, { size: 18, color: RAYCAST_COLOR.secondaryText }) : ""}`;

  return svgDocument(width, height, body);
}

// ─── Hub tile (monogram + name + one-line status) ──────────────────────────

export interface TileSpec {
  glyph: string; // one or two characters — fallback when no icon markup
  name: string;
  status: string; // one line, e.g. "3 overdue" or "…" while loading
  color?: RaycastColor;
  // Inner markup of a 512×512 command icon (assets/src/*.svg minus the outer
  // <svg>), drawn instead of the glyph circle so tiles match the launcher.
  iconMarkup?: string;
}

// Wide 16:9 tile — icon left, name + live status right. Three columns of
// these fit the hub's six commands in two short rows.
export function tile(
  spec: TileSpec,
  opts?: { width?: number; height?: number },
): string {
  const width = opts?.width ?? 480;
  const height = opts?.height ?? 270;
  const color = spec.color ?? RAYCAST_COLOR.blue;
  const iconSize = height * 0.5;
  const iconX = height * 0.14;
  const iconY = (height - iconSize) / 2;
  const textX = iconX + iconSize + height * 0.12;

  const icon = spec.iconMarkup
    ? `<g transform="translate(${iconX} ${iconY}) scale(${iconSize / 512})">${spec.iconMarkup}</g>`
    : `<rect x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="${iconSize * 0.22}" fill="${color}" />
    ${text(iconX + iconSize / 2, iconY + iconSize * 0.66, spec.glyph, { size: iconSize * 0.5, color: RAYCAST_COLOR.primaryText, weight: 700 })}`;

  const body = `
    <rect x="0" y="0" width="${width}" height="${height}" rx="${height * 0.12}" fill="${color}" fill-opacity="0.12" />
    ${icon}
    ${text(textX, height * 0.46, spec.name, { size: height * 0.14, color: RAYCAST_COLOR.primaryText, weight: 600, anchor: "start" })}
    ${text(textX, height * 0.66, spec.status, { size: height * 0.105, color: RAYCAST_COLOR.secondaryText, anchor: "start" })}`;

  return svgDocument(width, height, body);
}

// ─── Menu-bar ring (small, no text — reads only as a filled arc at 18pt) ───

export interface MenuBarRingSpec {
  percent: number; // 0-100
  color?: RaycastColor; // defaults to thresholdColor(percent)
  invert?: boolean;
}

// `ExtensionMenuBarImage.swift` fits whatever this returns into an 18×18pt
// `NSStatusItem` glyph (vector, so any canvas works — 64 here is just a
// comfortable stroke-width unit) — no text, since nothing reads at that
// size. Two concentric arcs (a full dim track + the coloured fill) so the
// glyph still reads as "a gauge" rather than a plain dot.
export function menuBarRing(spec: MenuBarRingSpec): string {
  const size = 64;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.36;
  const strokeWidth = size * 0.22;
  const percent = clamp(spec.percent, 0, 100);
  const color = spec.color ?? thresholdColor(percent, { invert: spec.invert });
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);

  const body = `
    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${RAYCAST_COLOR.secondaryText}" stroke-opacity="0.3" stroke-width="${strokeWidth}" />
    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${circumference} ${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})" />`;

  return svgDocument(size, size, body);
}

// ─── Signal bars ────────────────────────────────────────────────────────────

export interface SignalBarsSpec {
  percent: number; // 0-100
  bars?: number; // default 5
  label?: string; // e.g. "4G+"
}

export function signalBars(
  spec: SignalBarsSpec,
  opts?: { width?: number; height?: number },
): string {
  const width = opts?.width ?? HERO_COL_WIDTH;
  const height = opts?.height ?? 180;
  const barCount = spec.bars ?? 5;
  const percent = clamp(spec.percent, 0, 100);
  const filled = Math.max(1, Math.round((percent / 100) * barCount));
  const color = thresholdColor(percent, { invert: true });
  const maxBarHeight = height * 0.5;
  const baseY = height * 0.6;
  // A wide canvas (the hero-image default) shouldn't stretch each bar into
  // a pill — cap bar width relative to height and center the whole group.
  const gap = maxBarHeight * 0.18;
  const barWidth = Math.min(
    maxBarHeight * 0.32,
    (width - gap * (barCount - 1)) / barCount,
  );
  const groupWidth = barWidth * barCount + gap * (barCount - 1);
  const groupX = (width - groupWidth) / 2;

  const bars = Array.from({ length: barCount }, (_, i) => {
    const h = maxBarHeight * ((i + 1) / barCount);
    const x = groupX + i * (barWidth + gap);
    const y = baseY - h;
    const on = i < filled;
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="${barWidth * 0.25}" fill="${on ? color : RAYCAST_COLOR.secondaryText}" fill-opacity="${on ? 1 : 0.25}" />`;
  }).join("");

  const label = spec.label
    ? text(width / 2, height * 0.9, spec.label, {
        size: 20,
        color: RAYCAST_COLOR.primaryText,
        weight: 600,
      })
    : "";

  return svgDocument(width, height, bars + label);
}
