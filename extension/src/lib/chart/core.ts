// Shared foundation of the SVG chart library (`lib/svg.ts` is the public entry):
// the theme, the one `text()` emitter, SVG document/data-URI plumbing, the
// legibility check, gradient defs and the tiny formatting helpers every chart
// needs. Pure strings in, pure strings out — no DOM, no React.
//
// Every colour is a `raycast-*` name (never a hex literal): Tinycast's
// `ExtensionIconCache.rewritingNames` replaces those whole-word tokens with the
// live theme colour (`rgba(r,g,b,a)`) in the *entire* SVG source before
// `NSImage` decodes it — `fill`, `stroke`, `stop-color` in a gradient, inline
// `style`, all of it — which is the only way these SVGs adapt to light/dark.
// Opacity is therefore always a separate attribute (`fill-opacity`,
// `stroke-opacity`, `stop-opacity`), multiplied by the alpha the token carries
// (secondary text is already 60%). See `.claude/skills/svg-charts/SKILL.md`
// and `.claude/skills/tinycast/SKILL.md` § Designing for Tinycast.
//
// Target renderer: Tinycast **beta** (0.11.10-beta.x = upstream `main`),
// window 750×475 at `interfaceSize: standard`. Beta has **no 220pt image
// height cap** — a markdown image draws at its own intrinsic size, or fits an
// explicit `?raycast-width=&raycast-height=` hint, which `toDataUri()` always
// appends from the SVG's own canvas. Every Detail command renders full-width
// (no `Detail.Metadata` sidebar): the markdown pane is ≈730pt, and
// `HERO_COL_WIDTH` is a conservative round number under that. Every hero's
// canvas must be ≤ `HERO_COL_WIDTH` so it never shrinks — `assertLegible()`
// (and svg.test.ts's legibility block) enforce that and the ≥11pt text floor
// (≥20pt for a hero's one headline number).

import { Buffer } from "buffer";

// ≈730pt of markdown pane at the 750-wide `standard` window (10pt padding each
// side), minus a hair so an image never needs to shrink.
export const HERO_COL_WIDTH = 720;

// scale = min(1, columnWidth / svgWidth) — main never upscales an image past
// its intrinsic/hinted size, it only shrinks one that's too wide.
export function computeImageScale(colWidth: number, svgWidth: number): number {
  return Math.min(1, colWidth / svgWidth);
}

interface FontSizeEntry {
  size: number;
  role: "primary" | "label";
}

// Every `<text>` this library emits carries `data-role` right after
// `font-size` (see `text()` below) — this regex depends on that fixed order.
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

// Every text element must render ≥11pt; a `role: "primary"` element (the one
// headline number of a hero — a ring's percent) must render ≥20pt. Returns
// the violations rather than a boolean so a failing test prints exactly what
// is too small.
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

// One theme so every chart reads as one family. Semantic colours map onto the
// nine raycast-* tokens; sizes are fixed points (the canvas width already *is*
// the render width — see HERO_COL_WIDTH), never width-relative.
export const THEME = {
  color: {
    text: RAYCAST_COLOR.primaryText,
    muted: RAYCAST_COLOR.secondaryText,
    // Default series colour, then the second-series colour.
    accent: RAYCAST_COLOR.blue,
    accent2: RAYCAST_COLOR.purple,
    good: RAYCAST_COLOR.green,
    warn: RAYCAST_COLOR.orange,
    bad: RAYCAST_COLOR.red,
  },
  // Opacities multiply the alpha the raycast-* token already carries.
  opacity: {
    grid: 0.2, // hairline gridlines (secondary text ≈ 12% net)
    axis: 0.45, // baseline / zero line
    track: 0.2, // empty ring / bar track
    areaTop: 0.4, // gradient fill at the line
    areaBottom: 0, // …fading to transparent
    chip: 0.18, // value-chip background tint
    dim: 0.62, // de-emphasised bars
    shade: 0.1, // background spans (the night)
  },
  font: {
    family:
      "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    tick: 11, // axis ticks, extrema labels, reference labels
    label: 12, // legend, sublabels, bar x labels
    value: 13, // chip / value labels, row labels
    title: 14, // gauge labels, section row titles
  },
  stroke: { line: 2, hairline: 1, marker: 1.5 },
  pad: { x: 14, top: 14, bottom: 8 },
} as const;

export interface Size {
  width?: number;
  height?: number;
}

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

// Round a coordinate to 1 decimal — keeps the markup short and the data URI
// stable across float noise.
export function n(value: number): number {
  return Math.round(value * 10) / 10;
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
    ? [THEME.color.bad, THEME.color.warn, THEME.color.good]
    : [THEME.color.good, THEME.color.warn, THEME.color.bad];
  if (p < lowBoundary) return low;
  if (p < highBoundary) return mid;
  return high;
}

// Appends a `?raycast-width=&raycast-height=` hint matching the SVG's own
// declared size, read straight off the `<svg width height>` root tag
// `svgDocument()` always emits — one source of truth, so the hint can never
// drift from the canvas the shapes were laid out on. `ExtensionImageSize.swift`
// parses the hint from *after* the comma on a `data:` URL.
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

export interface TextSpec {
  x: number;
  y: number;
  content: string;
  size: number;
  color: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  opacity?: number;
  // "primary" = the one headline number of a hero (a ring's percent) — held to
  // a stricter ≥20pt floor by assertLegible(). Attribute order is fixed
  // (font-size immediately before data-role) — extractFontSizes() depends on it.
  role?: "primary" | "label";
}

export function text(spec: TextSpec): string {
  const opacity =
    spec.opacity !== undefined ? ` fill-opacity="${spec.opacity}"` : "";
  return `<text x="${n(spec.x)}" y="${n(spec.y)}" font-family="${THEME.font.family}" font-size="${n(spec.size)}" data-role="${spec.role ?? "label"}" font-weight="${spec.weight ?? 400}" fill="${spec.color}"${opacity} text-anchor="${spec.anchor ?? "middle"}">${escapeXml(spec.content)}</text>`;
}

// Rough advance width — enough to size a value chip or drop an overlapping
// axis label, not a typesetter. Digits and capitals run wide in SF, punctuation
// and `i`/`l` narrow.
export function textWidth(content: string, size: number): number {
  let em = 0;
  for (const ch of content) {
    if (/[\s.,:;'|!()[\]ilj]/.test(ch)) em += 0.32;
    else if (/[mwMW%@]/.test(ch)) em += 0.9;
    else if (/[A-Z0-9−+-]/.test(ch)) em += 0.62;
    else em += 0.56;
  }
  return em * size;
}

// A vertical fade of one colour — the area/bar gradient. Deterministic id (same
// params, same id, same definition) so two charts composed into one document
// by heroColumns() can share it without a collision.
export function fadeGradient(opts: {
  color: RaycastColor;
  from: number;
  to: number;
  direction?: "down" | "up" | "right";
}): { id: string; def: string } {
  const { color, from, to } = opts;
  const direction = opts.direction ?? "down";
  const id = `f-${color.slice("raycast-".length)}-${Math.round(from * 100)}-${Math.round(to * 100)}-${direction}`;
  const [x1, y1, x2, y2] = {
    down: [0, 0, 0, 1],
    up: [0, 1, 0, 0],
    right: [0, 0, 1, 0],
  }[direction];
  const def = `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${color}" stop-opacity="${from}"/><stop offset="1" stop-color="${color}" stop-opacity="${to}"/></linearGradient>`;
  return { id, def };
}

// ─── Number formatting ──────────────────────────────────────────────────────

const MINUS = "−";

// Compact, sign-aware default: 250, 12.3, 0.45 — no trailing zeros.
export function formatNumber(value: number): string {
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  const rounded = Number(magnitude.toFixed(digits));
  return `${value < 0 && rounded !== 0 ? MINUS : ""}${rounded}`;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// "Chip": a rounded tint behind a value, text on top. Returns the markup and
// the box so callers can keep two chips from colliding.
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export const CHIP_HEIGHT = 20;

export function chip(opts: {
  box: Box;
  content: string;
  color: RaycastColor;
}): string {
  const { box, content, color } = opts;
  return `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${box.height}" rx="${box.height / 2}" fill="${color}" fill-opacity="${THEME.opacity.chip}" />${text(
    {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2 + THEME.font.value * 0.36,
      content,
      size: THEME.font.value,
      color: THEME.color.text,
      weight: 600,
    },
  )}`;
}

export function chipWidth(content: string): number {
  return Math.round(textWidth(content, THEME.font.value) + 16);
}

// Empty state — a quiet centred line instead of a broken or blank image.
export function emptyChart(opts: {
  width: number;
  height: number;
  message?: string;
}): string {
  return svgDocument(
    opts.width,
    opts.height,
    text({
      x: opts.width / 2,
      y: opts.height / 2 + 4,
      content: opts.message ?? "No data yet",
      size: THEME.font.label,
      color: THEME.color.muted,
    }),
  );
}
