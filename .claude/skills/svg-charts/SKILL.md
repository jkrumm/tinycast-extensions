---
name: svg-charts
description: The chart/hero/SVG-visualization library of this extension (lib/svg.ts, lib/chart/) — areaChart, lineChart, barChart, sparkline, rings, battery/signal glyphs, tiles; theme, design rules, legibility limits, and the `make previews` loop. Use for any chart, hero image, gauge, sparkline or data-visualization work in extension/.
---

# svg-charts

Plain-SVG-string chart library for Tinycast Detail heroes, Grid tiles and menu-bar
icons. d3-scale / d3-shape / d3-time-format are used **as math only** (scales,
`.nice()` ticks, monotone curves, `arc`, time formats); output is a string, no DOM,
no React. Import from `lib/svg.ts` (re-exports `lib/chart/{core,series,bars,gauges,cards}.ts`).
Every primitive takes a typed spec object plus `{ width?, height? }` (default
`HERO_COL_WIDTH` = 720) and returns an `<svg>` string; wrap with `toDataUri()` for
markdown / `Grid.Item.content` / `MenuBarExtra` icon.

## Primitives

| Call | Use for |
|-|-|
| `areaChart({ times, series })` | "how much, over time": gradient area under a monotone line. 1–2 series, time x-axis |
| `lineChart({ times, series })` | same, lines by default — signed values (battery A), comparing two curves |
| `barChart({ items, orientation? })` | vertical day columns (`highlight: "last"`, `threshold`, `segments` = stacked) or `orientation: "horizontal"` ranked rows (spend by lane) |
| `sparkline({ values })` | axis-free trend inside a tile / small slot (`sparklineMarkup` embeds it) |
| `ringGaugeRow([...])`, `ring(spec)` | 1–3 quota/percent gauges, rounded caps, headline number (`valueText` overrides `NN%`) |
| `thresholdBar({ label, percent, valueText })` | one labelled bar (health) |
| `statusPanel({ columns })` | the top of a Detail: 1–3 big headline numbers with a horizontal gauge and one sub line (see § Status panel) |
| `statCards({ cards, size?, columns?, width? })` | a hairline strip of label / value cells; `size: "compact"` = the quiet one-row metrics under a panel |
| `batteryGlyph`, `signalBars`, `menuBarRing`, `tile`, `heroColumns` | glyphs; menu-bar ring has no text; `heroColumns` lays pre-rendered heroes side by side |

```ts
areaChart({
  times, // epoch ms ascending; x is proportional to time
  series: [
    { label: "Solar", color: RAYCAST_COLOR.yellow, values: pvW, format: (v) => `${Math.round(v)} W` },
    { label: "Battery current", color: RAYCAST_COLOR.blue, values: batA, axis: "right", fill: false,
      format: formatAmps, extrema: true },
  ],
}, { height: 200 });
// series: values may hold null/NaN (line breaks), domain: [0, 100] fixes the y range,
// reference: [{ value: 20, label: "20% low", color }] dashed threshold, fill overrides the chart kind.
```

Time-chart options for sparse or windowed data: `marks: [{ t, v, label? }]` draws dots (labelled when `label` is set) at exact measurements on the left axis (measured readings on an estimated curve; a label that would touch the previous is dropped), `axisWidth` + `hideXLabels` line up two charts stacked with `heroRows([a, b])` (one image, shared x axis), `series.times` gives a series its own
timestamps (a dense trend and sparse readings on one chart, each broken only by its own
gaps), `domain: [from, to]` fixes the x axis to a
window (a 3-day chart over a few readings still reads as 3 days), `dayAxis: true` swaps the
nice ticks for a weekday label centred in each local day plus a hairline at every midnight,
`shading: [{ from, to }]` draws faint background spans (the night — `THEME.opacity.shade`),
`lastValues: false` drops the last-value chip/legend value. A `null` in `values` breaks the
line — insert one between readings that are too far apart rather than interpolating.
`barChart` takes `sublabel` per item (a second muted axis line, e.g. the day number under the
weekday), `labelMode: "max"|"extremes"` (label only the tallest / the highlight and the
tallest) and `dim: false` (mark the highlight without dimming the rest — dimmed yellow turns
muddy in dark).

Behaviour you get for free: nice y ticks with hairline gridlines, a second y-axis
(`axis: "right"`) whose ticks land on the first axis' gridlines, a zero line when an
axis crosses 0, time ticks/format chosen from the tick step (`10:30` → `Sat 12:00` →
`Sat` → `5 Oct`; `xFormat` overrides), last-value dot + chip (single series) or
last values in the legend row (two series), isolated points drawn as dots, empty /
single / flat / non-finite input handled (`No data yet` placeholder for empty).

## Status panel, stat cards and the dashboard layout

Tinycast's window is translucent, so **nothing is a filled box**: panels and cards are type
plus hairlines (`THEME.color.muted` × 0.3 ≈ 18 % net), both appearances from tokens. The
visible fold of a Detail is only ~420 pt, so the top of a view is dense and every number is
drawn **once**.

```ts
statusPanel({                     // 1–3 big headline columns, 124 pt tall
  columns: [
    { label: "Battery", value: 82, unit: "%", percent: 82, gauge: "battery", // "battery" cell or thin "bar"
      color: RAYCAST_COLOR.green, marker: 80 /* a tick, e.g. the charge limit */,
      sub: "−4.1 A · empty in ~39h · 13.42 V" },
    { label: "Solar", value: 148, unit: "W", percent: 70, color: RAYCAST_COLOR.yellow, sub: "Bulk · 1.24 kWh today" },
  ],
});
statCards({                       // a hairline strip of label / value cells
  size: "compact",                // one 56 pt row: label over a 20 pt value (no sub, no sparkline)
  columns: 4,                     // standard: 1–4 (86 pt rows with a sub, else 60); compact: 1–6
  cards: [
    { label: "Internet", value: "Online", tone: "good" },            // tone = a dot after the label
    { label: "Today", value: "$10.40", delta: { value: "$4.82 vs avg", direction: "down", good: true } },
    { label: "Data", value: 14.2, unit: "GB", sub: "cycle", trend: series }, // sub/trend: standard size only
  ],
});
```

`value` is a string (verbatim) or number (`formatNumber`); missing / NaN / `null` → "—" and
the unit is dropped. Everything truncates with an ellipsis instead of overflowing; a long
value shrinks (panel 38 → 26 pt, card 24 → 20 pt) before it truncates. The value is the
`role: "primary"` text (≥ 20 pt, enforced). `PanelColumn.percent` fills the gauge
(clamped); `statCards`' `tone`/`delta.good` follow the colour rules below.

**Which one** — top down the layout of every Detail is *status panel → metrics row →
charts → (only what is left) a markdown table*:

- **Panel** for the 1–3 numbers the view is about (charge, speeds, signal), where a gauge
  helps. A **ring** (`ringGaugeRow`) only where the ring *is* the information (a quota
  percentage) — rings otherwise spend the whole fold on two numbers.
- **Compact row** for quiet secondary numbers that change a decision. Anything only worth
  a look when it goes wrong (cell imbalance, temperature) is a **warning line**, not a
  metric; numbers that change no decision are cut.
- **Table** only for long-tail reference text (APN, PIN, roaming, a history list).
- A chart that would repeat a panel number drops its last-value chip (`lastValues: false`).

`make previews` renders the `lib-cards` gallery and the full-page mocks `page-<command>`
(panel + row + charts stacked at the column width, dark + light, with the table mocks that
remain) — judge on the page, and on a real screenshot (`scripts/screenshot.sh`, tinycast
skill § Debugging), not on one card.

## Theme and rules

`THEME` (core.ts) is the one palette/typography: `color.{text,muted,accent,accent2,good,warn,bad}`
→ `RAYCAST_COLOR` tokens, `opacity.{grid,axis,track,areaTop,chip,dim}`, `font.{tick 11,label 12,value 13,title 14}`.
Never write a hex literal or invent a size.

- **Colour semantics**: green/orange/red only for good/warn/bad (`thresholdColor`, `invert` when high is good);
  blue = default series, purple = second series, yellow = solar. Fixed series colours for quantities with no
  good/bad reading (Mbps).
- **Density**: one hero = one idea. ≤ 2 series per chart, ≤ 6 bar rows, ≤ ~7 vertical bars labelled
  (more → only highlight + max labelled). Muted 11 px axis labels, hairline grid, no legend boxes, no titles
  inside the SVG (markdown `##` heading carries it).
- **Pick**: percent of a limit → ring or `thresholdBar`; ranked categories → horizontal bars; per-day totals →
  vertical bars with `highlight: "last"` and an average `threshold`; a quantity over time → `areaChart`;
  a signed quantity → `lineChart`; two units over one window → dual axis; inline trend → `sparkline`.
- **Legibility is enforced**: every `<text>` ≥ 11 pt at the rendered size, a ring's headline (`role: "primary"`)
  ≥ 20 pt, canvas width ≤ `HERO_COL_WIDTH` (`assertLegible`, svg.test.ts). Fonts are fixed points, not
  width-relative; heroes in a `heroColumns` row are built at `width / columns`.

## Tinycast rewrite: what survives (verified against Tinycast `main`, 2026-10)

`ExtensionIconCache.rewritingNames` replaces every whole-word `raycast-*` token in the **entire SVG source**
(not just `fill`/`stroke`) with `rgba(r,g,b,a)` before `NSImage(data:)` (CoreSVG) decodes it. So
`stop-color="raycast-blue"` in a `<linearGradient>` works, as do `stop-opacity`, `fill-opacity`,
`stroke-opacity` and `style="stop-color:raycast-…"` — verified by rendering through NSImage. Opacity must stay a
separate attribute and multiplies the token's own alpha (`raycast-primary-text` ≈ 0.85, `raycast-secondary-text`
0.6 — gridlines use `muted` × 0.2). Gradient ids are deterministic (`f-<colour>-<from>-<to>-<dir>`), so
`heroColumns` composition can share them. `fill/stroke="transparent"` is rewritten to `none`.
Gotcha: CoreSVG silently drops strokes/circles whose colour reads `rgba(…,1)`; Tinycast emits `1.0`, so the
preview palette must too.

## Preview loop (mandatory after any chart change)

```bash
make previews                        # → /tmp/tinycast-previews/<name>.{svg,dark.png,light.png} + sheet-<group>.png
make previews ARGS="van"             # filter by name/group
make previews ARGS="van --coresvg"   # same through macOS' own SVG decoder (what Tinycast really uses) → *.core.png
```

`scripts/chart-previews.ts` renders every production hero (built by the commands' own functions via
`lib/chart/production-heroes.ts`) plus a gallery of edge cases; `sheet-*.png` puts dark and light side by side.
**Read the sheets**, critique (collisions, clipping, crowding, contrast, consistency), fix, repeat; spot-check the
trickiest with `--coresvg`. A new production hero belongs in `production-heroes.ts` so tests and previews
cover it.

## Tests and perf

`lib/svg.test.ts`: per-primitive behaviour, edge cases (empty / single / flat / null gaps / negative / NaN /
1 h–30 d spans), soundness invariants (no NaN, only `raycast-*` colours, resolvable gradient refs), legibility of
every production hero. `lib/chart/bench.test.ts` times 1000 renders per primitive (run it with
`bunx vitest run src/lib/chart/bench.test.ts --silent=false`); measured on the dev Mac, ms/render:

| Primitive | ms | Primitive | ms |
|-|-|-|-|
| areaChart 72 h × 170 pts | 0.34 | ringGaugeRow × 3 | 0.02 |
| areaChart dual axis | 0.52 | batteryGlyph | 0.004 |
| lineChart 72 h | 0.20 | signalBars / menuBarRing | 0.003 / 0.004 |
| barChart vertical × 7 | 0.03 | thresholdBar | 0.002 |
| barChart horizontal × 6 | 0.01 | tile + trend | 0.12 |
| sparkline × 170 | 0.12 | areaChart + toDataUri | 0.35 |
| statCards × 8 + 4 trends | 0.44 | statusPanel × 2 | <0.1 |

Budget: < ~2 ms per hero. Large series cost bytes, not time (170 points ≈ 20 KB of SVG) — sparklines
downsample to 60 points; keep chart inputs to the data actually shown.
