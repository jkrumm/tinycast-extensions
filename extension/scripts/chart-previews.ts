// `make previews` — renders every production hero and a gallery of the chart
// library's primitives/edge cases to PNGs, dark and light, so a chart can be
// judged by eye instead of by assertion. Run from `extension/`:
//
//   bun scripts/chart-previews.ts [filter] [--coresvg]
//
// Output (default /tmp/tinycast-previews, override with PREVIEW_DIR):
//   <name>.svg                 the raw SVG, raycast-* tokens intact
//   <name>.{dark,light}.png    rendered
//   sheet-<group>.png          every chart of a group, dark left / light right
//
// Tinycast replaces `raycast-*` tokens with `rgba(…)` before NSImage decodes
// the SVG, so the same substitution is applied here (palette measured from
// Tinycast's own SwiftUI colours resolved per appearance). Default renderer is
// `rsvg-convert`; `--coresvg` renders through macOS' own SVG decoder (what
// Tinycast really uses) via scripts/coresvg-render.swift, written as
// `<name>.{dark,light}.core.png` for spot checks.

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import * as svg from "../src/lib/svg";
import { text as svgText } from "../src/lib/chart/core";
import { dailySpend, timeAxis, vanFixture } from "../src/lib/chart/fixtures";
import { productionHeroes } from "../src/lib/chart/production-heroes";

const OUT = process.env.PREVIEW_DIR ?? "/tmp/tinycast-previews";
const ZOOM = Number(process.env.PREVIEW_ZOOM ?? 2);
const CORESVG = process.argv.includes("--coresvg");
const FILTER = process.argv.slice(2).find((a) => !a.startsWith("--"));
const { RAYCAST_COLOR: C } = svg;

// Tinycast's `ExtensionImage.palette` resolved against dark/light aqua
// (SwiftUI system colours; text tokens are white/black at 0.847 / 0.6 alpha).
// Alpha is written `1.0`, as Tinycast does — CoreSVG drops strokes and circles
// whose colour reads `rgba(…,1)`.
const PALETTE = {
  dark: {
    bg: "#1e1e1e",
    colors: {
      "raycast-blue": "rgba(0,145,255,1.0)",
      "raycast-green": "rgba(48,209,88,1.0)",
      "raycast-magenta": "rgba(217,61,158,1.0)",
      "raycast-orange": "rgba(255,146,48,1.0)",
      "raycast-purple": "rgba(219,52,242,1.0)",
      "raycast-red": "rgba(255,66,69,1.0)",
      "raycast-yellow": "rgba(255,214,0,1.0)",
      "raycast-primary-text": "rgba(255,255,255,0.847)",
      "raycast-secondary-text": "rgba(255,255,255,0.6)",
    },
  },
  light: {
    bg: "#ffffff",
    colors: {
      "raycast-blue": "rgba(0,136,255,1.0)",
      "raycast-green": "rgba(52,199,89,1.0)",
      "raycast-magenta": "rgba(217,61,158,1.0)",
      "raycast-orange": "rgba(255,141,40,1.0)",
      "raycast-purple": "rgba(203,48,224,1.0)",
      "raycast-red": "rgba(255,56,60,1.0)",
      "raycast-yellow": "rgba(255,204,0,1.0)",
      "raycast-primary-text": "rgba(0,0,0,0.847)",
      "raycast-secondary-text": "rgba(0,0,0,0.6)",
    },
  },
} as const;
type Theme = keyof typeof PALETTE;
const THEMES: Theme[] = ["dark", "light"];

function themed(source: string, theme: Theme): string {
  return source.replace(
    /raycast-[a-z-]+/g,
    (name) => (PALETTE[theme].colors as Record<string, string>)[name] ?? name,
  );
}

interface Preview {
  group: string;
  name: string;
  svg: string;
}
const previews: Preview[] = [];
const add = (group: string, name: string, source: string) =>
  previews.push({ group, name, svg: source });

// ─── Fixtures ───────────────────────────────────────────────────────────────

const END = Date.UTC(2026, 9, 5, 14, 30);
const H = 3_600_000;
const D = 24 * H;
const fmt =
  (unit: string, digits = 0) =>
  (v: number) =>
    `${v.toFixed(digits)}${unit}`;

function series(spanMs: number, count: number, seed: number) {
  const van = vanFixture({ end: END, hours: spanMs / H, count, seed });
  return { times: van.times, van };
}

// ─── Library gallery ────────────────────────────────────────────────────────

for (const [name, spanMs, count] of [
  ["1h", H, 30],
  ["6h", 6 * H, 48],
  ["24h", D, 96],
  ["72h", 3 * D, 144],
  ["7d", 7 * D, 120],
  ["30d", 30 * D, 120],
] as const) {
  const { times, van } = series(spanMs, count, 5);
  add(
    "lib-time",
    `area-${name}`,
    svg.areaChart({
      times,
      series: [
        {
          label: `Solar · ${name}`,
          color: C.yellow,
          values: van.solarW,
          format: fmt(" W"),
          extrema: true,
        },
      ],
    }),
  );
}

{
  const { times, van } = series(3 * D, 144, 9);
  add(
    "lib-dual",
    "dual-solar-battery",
    svg.areaChart(
      {
        times,
        series: [
          {
            label: "Solar",
            color: C.yellow,
            values: van.solarW,
            axis: "left",
            format: fmt(" W"),
          },
          {
            label: "Battery current",
            color: C.blue,
            values: van.batteryA,
            axis: "right",
            fill: false,
            format: (v) =>
              `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(1)} A`,
          },
        ],
      },
      { height: 200 },
    ),
  );
  add(
    "lib-dual",
    "line-two-same-axis",
    svg.lineChart({
      times,
      series: [
        {
          label: "Charge",
          color: C.green,
          values: van.soc,
          domain: [0, 100],
          format: fmt("%"),
          reference: [{ value: 20, label: "20% low", color: C.red }],
        },
        {
          label: "Solar",
          color: C.orange,
          values: van.solarW.map((w) => w / 3),
          axis: "left",
          format: fmt(""),
        },
      ],
    }),
  );
  add(
    "lib-dual",
    "line-negative",
    svg.lineChart({
      times,
      series: [
        {
          label: "Battery current",
          color: C.blue,
          values: van.batteryA,
          format: fmt(" A", 1),
          extrema: true,
        },
      ],
    }),
  );
}

{
  const times = timeAxis({ end: END, spanMs: D, count: 24 });
  const gaps = times.map((_, i) =>
    (i > 7 && i < 12) || i === 16 ? null : 40 + 30 * Math.sin(i / 3),
  );
  add(
    "lib-edge",
    "gaps",
    svg.areaChart({
      times,
      series: [
        {
          label: "With gaps",
          color: C.blue,
          values: gaps,
          format: fmt(" Mbps"),
        },
      ],
    }),
  );
  add(
    "lib-edge",
    "single-point",
    svg.areaChart({
      times: [END],
      series: [
        {
          label: "One point",
          color: C.blue,
          values: [42],
          format: fmt(" Mbps"),
        },
      ],
    }),
  );
  add(
    "lib-edge",
    "flat",
    svg.lineChart({
      times,
      series: [
        {
          label: "Flat",
          color: C.green,
          values: times.map(() => 5),
          format: fmt(" V", 1),
        },
      ],
    }),
  );
  add(
    "lib-edge",
    "empty",
    svg.areaChart({
      times,
      series: [
        { label: "Empty", color: C.blue, values: times.map(() => null) },
      ],
    }),
  );
}

{
  const days = dailySpend({ days: 7 });
  const labels = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
  const usd = (v: number) => `$${v.toFixed(2)}`;
  const items = days.map((value, i) => ({ label: labels[i], value }));
  add(
    "lib-bars",
    "bar-days",
    svg.barChart({
      items,
      format: usd,
      highlight: "last",
      threshold: { value: days.reduce((a, b) => a + b, 0) / 7, label: "avg" },
    }),
  );
  add(
    "lib-bars",
    "bar-days-nolabels",
    svg.barChart({ items, format: usd, labels: false }),
  );
  const month = dailySpend({ days: 30, seed: 8 });
  add(
    "lib-bars",
    "bar-30",
    svg.barChart({
      items: month.map((value, i) => ({ label: String(i + 1), value })),
      format: usd,
      highlight: "last",
    }),
  );
  add(
    "lib-bars",
    "bar-negative",
    svg.barChart({
      items: [
        { label: "Mon", value: 4 },
        { label: "Tue", value: -2.5 },
        { label: "Wed", value: 1.2 },
        { label: "Thu", value: -4 },
      ],
      format: usd,
    }),
  );
  add(
    "lib-bars",
    "bar-stacked",
    svg.barChart({
      items: days.slice(0, 5).map((v, i) => ({
        label: labels[i],
        value: 0,
        segments: [
          { value: v * 0.6, color: C.blue },
          { value: v * 0.3, color: C.purple },
          { value: v * 0.1, color: C.orange },
        ],
      })),
      format: usd,
    }),
  );
  add(
    "lib-bars",
    "bar-horizontal",
    svg.barChart({
      orientation: "horizontal",
      format: usd,
      items: [
        { label: "claude-code", value: 4.82 },
        { label: "codex", value: 2.1 },
        { label: "opencode", value: 1.4 },
        { label: "warden", value: 0.92 },
        { label: "other", value: 0.31 },
      ],
    }),
  );
  add("lib-bars", "bar-empty", svg.barChart({ items: [] }));
  add(
    "lib-bars",
    "threshold-bars",
    svg.heroColumns(
      [
        svg.thresholdBar(
          { label: "Quota", percent: 30, valueText: "30%" },
          { width: 340 },
        ),
        svg.thresholdBar(
          { label: "Quota", percent: 95, valueText: "95%" },
          { width: 340 },
        ),
      ],
      { width: 680 },
    ),
  );
}

{
  const v = series(3 * D, 60, 4).van;
  add(
    "lib-small",
    "sparklines",
    svg.heroColumns(
      [
        svg.sparkline(
          { values: v.soc, color: C.green },
          { width: 220, height: 48 },
        ),
        svg.sparkline(
          { values: v.solarW, color: C.yellow },
          { width: 220, height: 48 },
        ),
        svg.sparkline(
          { values: [3, null, 5, 8, 4, 6], color: C.blue },
          { width: 220, height: 48 },
        ),
      ],
      { width: 680, height: 60 },
    ),
  );
  add(
    "lib-small",
    "ring-single",
    svg.ring({ percent: 72, label: "Disk", sublabel: "72 of 100 GB" }),
  );
  add(
    "lib-small",
    "rings-states",
    svg.ringGaugeRow([
      { percent: 0, label: "Empty", sublabel: "0%" },
      { percent: 3, label: "Tiny", sublabel: "3%" },
      { percent: 62, label: "Mid", sublabel: "62%" },
      { percent: 100, label: "Full", sublabel: "100%" },
    ]),
  );
  add(
    "lib-small",
    "battery-glyphs",
    svg.heroColumns(
      [
        svg.batteryGlyph(
          { percent: 18, charging: false, wattsLabel: "−6.2 W" },
          { width: 226, height: 170 },
        ),
        svg.batteryGlyph(
          {
            percent: 64,
            charging: true,
            limitPercent: 80,
            wattsLabel: "+22 W",
          },
          { width: 226, height: 170 },
        ),
        svg.batteryGlyph({ percent: 100 }, { width: 226, height: 170 }),
      ],
      { width: 680, height: 170 },
    ),
  );
  add(
    "lib-small",
    "signal-bars",
    svg.heroColumns(
      [
        svg.signalBars(
          { percent: 12, label: "3G" },
          { width: 226, height: 170 },
        ),
        svg.signalBars(
          { percent: 55, label: "4G" },
          { width: 226, height: 170 },
        ),
        svg.signalBars(
          { percent: 96, label: "4G+" },
          { width: 226, height: 170 },
        ),
      ],
      { width: 680, height: 170 },
    ),
  );
  add("lib-small", "menubar-ring", svg.menuBarRing({ percent: 62 }));
}

// ─── Stat cards ─────────────────────────────────────────────────────────────

{
  const spark = vanFixture({ end: END, hours: 24, count: 40, seed: 6 });
  const base: svg.StatCard[] = [
    {
      label: "Net current",
      value: "+8.4",
      unit: "A",
      tone: "good",
      sub: "full in ~3h",
      trend: spark.batteryA,
    },
    {
      label: "Solar",
      value: 148,
      unit: "W",
      sub: "Bulk",
      trend: spark.solarW,
      trendColor: C.yellow,
    },
    { label: "Yield today", value: "1.24", unit: "kWh" },
    {
      label: "Cells Δ",
      value: 34,
      unit: "mV",
      tone: "warn",
      sub: "4 cells",
    },
    {
      label: "Voltage",
      value: "13.42",
      unit: "V",
      tone: "bad",
      sub: "3.351–3.362 V",
      delta: { value: "0.2 V", direction: "down", good: false },
    },
    {
      label: "Temp",
      value: "24.5",
      unit: "°C",
      delta: { value: "1.1", direction: "up" },
    },
    { label: "Cycles", value: 407, tone: "accent" },
    { label: "Capacity", value: null, unit: "Ah", sub: "not reported" },
  ];
  for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
    add(
      "lib-cards",
      `cards-${count}`,
      svg.statCards({ cards: base.slice(0, count) }),
    );
  }
  add(
    "lib-cards",
    "cards-edge",
    svg.statCards({
      columns: 3,
      cards: [
        {
          label: "A very long label that cannot possibly fit",
          value: "123456789.123",
          unit: "kWh",
          sub: "an equally long sub line that must be truncated with an ellipsis",
          tone: "good",
          delta: { value: "12.5 kWh", direction: "up", good: true },
        },
        { label: "Missing", value: undefined, unit: "A", sub: "—" },
        { label: "NaN", value: NaN, trend: [1, 2], sub: "one sparkline" },
      ],
    }),
  );
  add(
    "lib-cards",
    "cards-nosub",
    svg.statCards({
      cards: base.slice(0, 4).map(({ sub: _sub, ...c }) => c),
    }),
  );
}

// ─── Production heroes (the exact builders the commands embed) ──────────────

for (const hero of productionHeroes(END)) add(hero.group, hero.name, hero.svg);

// Hub tiles are built inside hub.tsx (they read the icon art from disk), so the
// gallery draws them with the same icons and a representative status each.
{
  const assets = join(import.meta.dir, "..", "assets", "src");
  const icon = (name: string) =>
    readFileSync(join(assets, `${name}.svg`), "utf8")
      .replace(/^[\s\S]*?<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "");
  const trend = vanFixture({ end: END, hours: 72, count: 40, seed: 2 }).soc;
  const speed = [60, 82, 71, 95, 120, 88, 138];
  const tiles = [
    {
      name: "Tasks",
      glyph: "T",
      status: "3 overdue",
      color: C.blue,
      icon: "tasks",
    },
    {
      name: "Claude Usage",
      glyph: "C",
      status: "5h 62% · 7d 88%",
      color: C.purple,
      icon: "usage",
    },
    {
      name: "Netgear",
      glyph: "N",
      status: "LTE+ · 48%",
      color: C.orange,
      icon: "netgear",
    },
    {
      name: "Speed Test",
      glyph: "S",
      status: "138 Mbps",
      color: C.green,
      icon: "speed-test",
      trend: speed,
    },
    {
      name: "Battery",
      glyph: "B",
      status: "76% · limit 80%",
      color: C.magenta,
      icon: "battery",
    },
    {
      name: "Van Power",
      glyph: "V",
      status: "82% · +4.1A",
      color: C.yellow,
      icon: "van",
      trend,
    },
  ];
  for (const t of tiles) {
    const iconMarkup = existsSync(join(assets, `${t.icon}.svg`))
      ? icon(t.icon)
      : undefined;
    add("hub", `tile-${t.icon}`, svg.tile({ ...t, iconMarkup }));
  }
  add(
    "hub",
    "tile-offline",
    svg.tile({
      glyph: "N",
      name: "Netgear",
      status: "Offline",
      color: C.orange,
    }),
  );
}

// ─── Full-page mocks: the images of a Detail stacked at the real column ─────

// A page item is a preview name or a pre-built mock (markdown table / line).
type PageItem = string | { svg: string };

// Approximates Tinycast's markdown table: a blank shaded header row (the
// "| | |" no-header trick) and hairline-bordered cells, 13pt text, label cells
// muted. `before` mocks of the tables the cards replace.
function tableMock(rows: string[][], width = svg.HERO_COL_WIDTH): { svg: string } {
  const ROW = 30;
  const columns = rows[0].length;
  // label columns narrow, value columns wide (Tinycast sizes by content)
  const weights = columns > 2 ? [0.16, 0.34, 0.16, 0.34] : [0.3, 0.7];
  const edges = weights.reduce<number[]>(
    (acc, w) => [...acc, acc[acc.length - 1] + w * width],
    [0],
  );
  const height = ROW * (rows.length + 1);
  const cells = rows
    .flatMap((row, r) =>
      row.map((cell, c) => {
        const label = columns > 2 ? c % 2 === 0 : c === 0;
        return bodyText({
          x: edges[c] + 12,
          y: ROW * (r + 1) + 20,
          content: cell,
          color: label ? C.secondaryText : C.primaryText,
        });
      }),
    )
    .join("");
  const lines = Array.from(
    { length: rows.length + 2 },
    (_, i) =>
      `<line x1="0" x2="${width}" y1="${i * ROW + 0.5}" y2="${i * ROW + 0.5}" stroke="${C.secondaryText}" stroke-opacity="0.3" />`,
  ).join("");
  const verticals = Array.from(
    { length: columns + 1 },
    (_, i) =>
      `<line y1="0" y2="${height}" x1="${edges[i] + 0.5}" x2="${edges[i] + 0.5}" stroke="${C.secondaryText}" stroke-opacity="0.3" />`,
  ).join("");
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${ROW}" fill="${C.secondaryText}" fill-opacity="0.12" />${lines}${verticals}${cells}</svg>`,
  };
}

const bodyText = (o: {
  x: number;
  y: number;
  content: string;
  color: string;
}) => svgText({ ...o, size: 13, anchor: "start" });

// One markdown text line (a headline sentence) in body size.
function lineMock(content: string, width = svg.HERO_COL_WIDTH): { svg: string } {
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22" viewBox="0 0 ${width} 22">${bodyText({ x: 0, y: 16, content, color: C.primaryText })}</svg>`,
  };
}

function stackedPage(items: PageItem[]): string {
  const PAGE_PAD = 20; // Tinycast's Spacing.lg ≈ 10pt each side + breathing room
  const GAP = 14;
  const parts = items.map((item) => {
    if (typeof item !== "string")
      return { ...dimensions(item.svg), svg: item.svg };
    const found = previews.find((p) => p.name === item);
    if (!found) throw new Error(`stackedPage: no preview "${item}"`);
    return { ...dimensions(found.svg), svg: found.svg };
  });
  const width = Math.max(...parts.map((p) => p.width)) + PAGE_PAD * 2;
  let y = PAGE_PAD;
  const body = parts
    .map((p, i) => {
      const inner = scoped(p.svg, `p${i}-`).replace(
        "<svg ",
        `<svg x="${PAGE_PAD}" y="${y}" `,
      );
      y += p.height + GAP;
      return inner;
    })
    .join("");
  const height = y - GAP + PAGE_PAD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

// Full-page mocks of each Detail: its images stacked at the real column width.
// (The "before" of a layout is a real screenshot — see the tinycast skill §
// Debugging — not a mock.)
const PAGES: Record<string, PageItem[]> = {
  "page-van": [
    "van-panel",
    "van-charge",
    lineMock("Solar yield · last 14 days · 35.5 kWh in 30 days"),
    "van-yield",
  ],
  "page-van-dense": ["van-panel", "van-charge-dense", "van-yield"],
  "page-van-solar-only": ["van-panel", "van-charge-solar-only", "van-yield"],
  "page-battery": ["battery-panel", "battery-metrics"],
  "page-battery-low": ["battery-panel-low", "battery-metrics-low"],
  "page-speed": [
    "speed-panel",
    "speed-metrics",
    lineMock("History (download, Mbps)"),
    "speed-history",
    tableMock([
      ["Time", "Down", "Up", "Latency"],
      ["05.10. 14:30", "51 Mbps", "22 Mbps", "42 ms"],
      ["05.10. 11:10", "88 Mbps", "—", "40 ms"],
    ]),
  ],
  "page-usage": [
    "usage-quota",
    "usage-totals",
    lineMock("Spend today"),
    "usage-lanes",
    lineMock("Last 7 days"),
    "usage-days",
  ],
  "page-netgear": [
    "netgear-panel",
    "netgear-metrics",
    tableMock([
      [
        "Roaming",
        "Allowed · roaming now (Orange)",
        "APN",
        "internet · internet.fake",
      ],
      ["PIN", "Lock on · 3 tries · saved", "SMS", "2 unread"],
    ]),
  ],
};
for (const [name, members] of Object.entries(PAGES)) {
  const named = members.filter((m): m is string => typeof m === "string");
  if (named.every((m) => previews.some((p) => p.name === m))) {
    add("pages", name, stackedPage(members));
  }
}

// ─── Render ─────────────────────────────────────────────────────────────────

function rsvg(source: string, outPath: string, theme: Theme): void {
  execFileSync(
    "rsvg-convert",
    [
      "--background-color",
      PALETTE[theme].bg,
      "--zoom",
      String(ZOOM),
      "-o",
      outPath,
    ],
    { input: themed(source, theme) },
  );
}

function coresvgBinary(): string {
  const bin = join(OUT, ".coresvg-render");
  const src = join(import.meta.dir, "coresvg-render.swift");
  const stale =
    !existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs;
  if (stale)
    execFileSync("swiftc", ["-O", "-o", bin, src], { stdio: "inherit" });
  return bin;
}

function dimensions(source: string): { width: number; height: number } {
  const m = source.match(
    /<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/,
  )!;
  return { width: Number(m[1]), height: Number(m[2]) };
}

// Re-id every gradient/clip per cell so dark and light copies of the same
// definition can live in one sheet.
function scoped(source: string, prefix: string): string {
  return source
    .replace(/id="([^"]+)"/g, `id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`);
}

function sheet(group: string, items: Preview[]): void {
  const gap = 16;
  const cells = items.map((p) => ({ p, ...dimensions(p.svg) }));
  const colWidth = Math.max(...cells.map((c) => c.width));
  const width = colWidth * 2 + gap * 3;
  let y = gap;
  const parts: string[] = [];
  cells.forEach((cell, i) => {
    THEMES.forEach((theme, t) => {
      const x = gap + t * (colWidth + gap);
      const inner = scoped(
        themed(cell.p.svg, theme),
        `s${i}${theme[0]}-`,
      ).replace("<svg ", `<svg x="${x}" y="${y}" `);
      parts.push(
        `<rect x="${x}" y="${y}" width="${colWidth}" height="${cell.height}" fill="${PALETTE[theme].bg}" />${inner}`,
      );
    });
    y += cell.height + gap;
  });
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y}" viewBox="0 0 ${width} ${y}"><rect width="${width}" height="${y}" fill="#808080" />${parts.join("")}</svg>`;
  execFileSync(
    "rsvg-convert",
    ["--zoom", String(ZOOM), "-o", join(OUT, `sheet-${group}.png`)],
    { input: doc },
  );
}

mkdirSync(OUT, { recursive: true });
const selected = previews.filter(
  (p) => !FILTER || p.name.includes(FILTER) || p.group.includes(FILTER),
);
if (selected.length === 0) throw new Error(`no preview matches "${FILTER}"`);

for (const p of selected) {
  writeFileSync(join(OUT, `${p.name}.svg`), p.svg);
  for (const theme of THEMES) {
    if (CORESVG) {
      writeFileSync(join(OUT, `.${p.name}.src.svg`), p.svg);
      execFileSync(coresvgBinary(), [
        join(OUT, `.${p.name}.src.svg`),
        theme,
        join(OUT, `${p.name}.${theme}.core.png`),
        String(ZOOM),
      ]);
      rmSync(join(OUT, `.${p.name}.src.svg`));
    } else {
      rsvg(p.svg, join(OUT, `${p.name}.${theme}.png`), theme);
    }
  }
}
if (!CORESVG) {
  for (const group of new Set(selected.map((p) => p.group))) {
    sheet(
      group,
      selected.filter((p) => p.group === group),
    );
  }
}
console.log(`${selected.length} previews → ${OUT}`);
for (const p of selected) console.log(`  ${p.name}`);
