import { describe, it, expect } from "vitest";
import {
  RAYCAST_COLOR,
  HERO_COL_WIDTH,
  THEME,
  clamp,
  escapeXml,
  formatNumber,
  thresholdColor,
  toDataUri,
  svgDocument,
  computeImageScale,
  assertLegible,
  areaChart,
  lineChart,
  sparkline,
  barChart,
  thresholdBar,
  ring,
  ringGaugeRow,
  batteryGlyph,
  signalBars,
  menuBarRing,
  tile,
  heroColumns,
  statCards,
  statusPanel,
} from "./svg";
import type { StatCard } from "./svg";
import { dailySpend, timeAxis, vanFixture } from "./chart/fixtures";
import { decodeDataUri, productionHeroes } from "./chart/production-heroes";

const C = RAYCAST_COLOR;
const NOW = Date.UTC(2026, 9, 5, 14, 30);
const H = 3_600_000;
const D = 24 * H;

// Invariants every image this library emits must satisfy: nothing numeric
// leaks as NaN/undefined/Infinity, every colour is a raycast-* token (never a
// hex literal Tinycast could not adapt), every gradient reference resolves,
// and the canvas fits the column.
function assertSound(name: string, svg: string): void {
  expect(svg, name).toMatch(/^<svg [^>]*width="[\d.]+" height="[\d.]+"/);
  expect(svg, name).not.toMatch(/NaN|undefined|Infinity/);
  expect(svg, name).not.toMatch(/(?:fill|stroke|stop-color)="#/);
  for (const [, id] of svg.matchAll(/url\(#([^)]+)\)/g)) {
    expect(svg, `${name}: dangling #${id}`).toContain(`id="${id}"`);
  }
  expect(svg.match(/<text/g)?.length ?? 0, name).toBe(
    svg.match(/<\/text>/g)?.length ?? 0,
  );
  const width = Number(svg.match(/width="([\d.]+)"/)![1]);
  expect(width, name).toBeLessThanOrEqual(HERO_COL_WIDTH);
}

function assertLegibleAtColumn(name: string, svg: string): void {
  const width = Number(svg.match(/width="([\d.]+)"/)![1]);
  const violations = assertLegible(svg, HERO_COL_WIDTH, width);
  expect(violations, `${name}: ${violations.join("; ")}`).toEqual([]);
}

describe("helpers", () => {
  it("clamp / escapeXml", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(42, 0, 100)).toBe(42);
    expect(escapeXml(`<a> & "b" it's`)).toBe(
      "&lt;a&gt; &amp; &quot;b&quot; it's",
    );
  });

  it("formatNumber: compact, signed with a real minus, no trailing zeros", () => {
    expect(formatNumber(250)).toBe("250");
    expect(formatNumber(12.34)).toBe("12.3");
    expect(formatNumber(0.5)).toBe("0.5");
    expect(formatNumber(-3.2)).toBe("−3.2");
    expect(formatNumber(-0.001)).toBe("0");
  });

  it("thresholdColor: 50/80 split, invertible, custom boundaries", () => {
    expect(thresholdColor(49)).toBe(C.green);
    expect(thresholdColor(50)).toBe(C.orange);
    expect(thresholdColor(80)).toBe(C.red);
    expect(thresholdColor(10, { invert: true })).toBe(C.red);
    expect(thresholdColor(90, { invert: true })).toBe(C.green);
    expect(
      thresholdColor(48, { invert: true, lowBoundary: 35, highBoundary: 60 }),
    ).toBe(C.orange);
  });

  it("toDataUri: base64 SVG with a raycast-width/height hint matching the canvas", () => {
    const uri = toDataUri(svgDocument(320, 90, "<rect/>"));
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(uri).toContain("?raycast-width=320&raycast-height=90");
    expect(decodeDataUri(uri)).toContain("<rect/>");
  });

  it("svgDocument / computeImageScale", () => {
    const svg = svgDocument(900, 220, "<circle/>");
    expect(svg).toContain('viewBox="0 0 900 220"');
    expect(computeImageScale(680, 400)).toBe(1);
    expect(computeImageScale(400, 800)).toBeCloseTo(0.5, 5);
  });

  it("assertLegible flags text under 11pt and a primary under 20pt", () => {
    const small = `<text font-size="9" data-role="label">x</text>`;
    const primary = `<text font-size="18" data-role="primary">x</text>`;
    expect(assertLegible(small, 680, 680)).toHaveLength(1);
    expect(assertLegible(primary, 680, 680)).toHaveLength(1);
    expect(assertLegible(primary, 680, 1360)).toHaveLength(2); // shrunk to 9pt
  });
});

describe("areaChart / lineChart", () => {
  const times = timeAxis({ end: NOW, spanMs: 5 * H, count: 6 });

  it("draws a gradient area, a smoothed line, a last-value dot and chip", () => {
    const svg = areaChart({
      times,
      series: [
        {
          color: C.yellow,
          values: [0, 40, 120, 200, 90, 0],
          format: (v) => `${Math.round(v)} W`,
        },
      ],
    });
    assertSound("area", svg);
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain('stop-opacity="0"');
    expect(svg).toMatch(/<path d="M[^"]*C/); // monotone curve, not polyline
    expect(svg).toContain(">0 W<"); // last-value chip
    expect(svg.match(/<circle/g)).toHaveLength(2); // dot + halo
  });

  it("lineChart draws no fill unless a series asks for it", () => {
    const base = {
      times,
      series: [{ color: C.blue, values: [1, 2, 3, 2, 4, 5] }],
    };
    expect(lineChart(base)).not.toContain("<linearGradient");
    expect(
      lineChart({ times, series: [{ ...base.series[0], fill: true }] }),
    ).toContain("<linearGradient");
    expect(
      areaChart({ times, series: [{ ...base.series[0], fill: false }] }),
    ).not.toContain("<linearGradient");
  });

  it("two series: legend carries the last values, no chips, axes share gridlines", () => {
    const svg = areaChart({
      times,
      series: [
        {
          label: "Solar",
          color: C.yellow,
          values: [0, 40, 120, 200, 90, 10],
          format: (v) => `${Math.round(v)} W`,
        },
        {
          label: "Battery",
          color: C.blue,
          values: [-3, -2, 4, 8, 1, -3],
          fill: false,
          format: (v) => `${v.toFixed(1)} A`,
        },
      ],
    });
    assertSound("dual", svg);
    expect(svg).toContain(">Solar<");
    expect(svg).toContain(">10 W<");
    expect(svg).toContain(">-3.0 A<"); // the caller's format
    expect(svg).not.toContain("<rect"); // no chip
    // Right-axis ticks sit on the left axis' gridlines: same tick count.
    const left = svg.match(/text-anchor="end"/g)?.length ?? 0;
    const right = [
      ...svg.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="start"/g),
    ].filter(([, x]) => Number(x) > HERO_COL_WIDTH * 0.8).length;
    expect(left).toBeGreaterThan(1);
    expect(right).toBe(left);
    expect(svg).toContain("stroke-opacity"); // zero line + gridlines
  });

  it("breaks the line at missing values instead of bridging them", () => {
    const svg = lineChart({
      times,
      series: [{ color: C.green, values: [50, 55, null, null, 70, 72] }],
    });
    assertSound("gaps", svg);
    const path = svg.match(/<path d="(M[^"]*)" fill="none"/)![1];
    expect(path.match(/M/g)).toHaveLength(2);
  });

  it("an isolated point between gaps still gets a dot", () => {
    const svg = lineChart({
      times,
      series: [{ color: C.green, values: [50, null, 60, null, 70, 72] }],
    });
    expect(svg.match(/<circle[^>]*r="2.5"/g)).toHaveLength(2);
  });

  it("survives one point, flat data, all-null, empty and non-finite input", () => {
    const cases: Array<[number[], Array<number | null>]> = [
      [[NOW], [5]],
      [times, [3, 3, 3, 3, 3, 3]],
      [times, [null, null, null, null, null, null]],
      [[], []],
      [times, [NaN, Infinity, 1, 2, -Infinity, 4]],
      [
        [NOW, NOW],
        [1, 2],
      ],
    ];
    for (const [t, values] of cases) {
      for (const chart of [areaChart, lineChart]) {
        assertSound(
          `edge ${JSON.stringify(values)}`,
          chart({ times: t, series: [{ color: C.blue, values }] }),
        );
      }
    }
    expect(
      areaChart({
        times,
        series: [{ color: C.blue, values: times.map(() => null) }],
      }),
    ).toContain("No data yet");
  });

  it("negative values: zero line and a baseline at zero for the area", () => {
    const svg = areaChart({
      times,
      series: [{ color: C.blue, values: [-5, -2, 3, 6, 2, -4] }],
    });
    assertSound("negative", svg);
    expect(svg).toContain(">−5<");
  });

  it("fixed domain, reference line and extrema", () => {
    const svg = areaChart({
      times,
      series: [
        {
          color: C.green,
          values: [80, 60, 30, 20, 50, 70],
          domain: [0, 100],
          format: (v) => `${Math.round(v)}%`,
          reference: [{ value: 20, label: "20% low", color: C.red }],
          extrema: true,
        },
      ],
    });
    assertSound("reference", svg);
    expect(svg).toContain(">0%<");
    expect(svg).toContain(">100%<");
    expect(svg).toContain("stroke-dasharray");
    expect(svg).toContain("20% low");
    expect(svg).toContain(">80%<"); // max marker
    expect(svg).toContain(">20%<"); // min marker
  });

  it("xFormat overrides the automatic tick labels", () => {
    const svg = lineChart({
      times,
      series: [{ color: C.blue, values: [1, 2, 3, 4, 5, 6] }],
      xFormat: (t) => `h${Math.round((t - times[0]) / H)}`,
    });
    expect(svg).toMatch(/>h\d<.*>h\d</s);
  });

  it("time spans from 1 hour to 30 days: 2+ tick labels, sound, legible, deterministic", () => {
    for (const [span, count] of [
      [H, 30],
      [6 * H, 48],
      [D, 96],
      [3 * D, 144],
      [7 * D, 120],
      [30 * D, 120],
    ] as const) {
      const van = vanFixture({ end: NOW, hours: span / H, count });
      const spec = {
        times: van.times,
        series: [
          {
            label: "Solar",
            color: C.yellow,
            values: van.solarW,
            extrema: true,
          },
        ],
      };
      const svg = areaChart(spec);
      assertSound(`span ${span / H}h`, svg);
      assertLegibleAtColumn(`span ${span / H}h`, svg);
      const ticks = svg.match(
        /y="1[5-9]\d(?:\.\d)?" font-family[^>]*text-anchor="middle"/g,
      );
      expect(ticks?.length ?? 0, `span ${span / H}h`).toBeGreaterThanOrEqual(2);
      expect(areaChart(spec)).toBe(svg);
    }
  });
});

describe("sparkline", () => {
  it("draws gradient area, line and an end dot", () => {
    const svg = sparkline({ values: [1, 5, 2, 8, 3] });
    assertSound("sparkline", svg);
    expect(svg).toContain("<linearGradient");
    expect(svg.match(/<circle/g)).toHaveLength(2);
  });

  it("edge cases: single, empty, flat, null/NaN gaps, no fill", () => {
    for (const values of [
      [5],
      [],
      [2, 2, 2],
      [40, null, NaN, 65],
      [null, null],
    ]) {
      assertSound(`spark ${JSON.stringify(values)}`, sparkline({ values }));
    }
    expect(sparkline({ values: [1, 2, 3], fill: false })).not.toContain(
      "<linearGradient",
    );
  });
});

describe("barChart", () => {
  const items = ["Mon", "Tue", "Wed", "Thu", "Fri"].map((label, i) => ({
    label,
    value: [4, 7, 2, 5, 3][i],
  }));
  const usd = (v: number) => `$${v.toFixed(2)}`;

  it("vertical: rounded gradient bars, value labels, x labels", () => {
    const svg = barChart({ items, format: usd });
    assertSound("bars", svg);
    expect(svg.match(/<path d="M[^"]*A/g)).toHaveLength(5);
    expect(svg).toContain(">$7.00<");
    expect(svg).toContain(">Wed<");
  });

  it("highlight dims the others; threshold draws a labelled reference", () => {
    const svg = barChart({
      items,
      format: usd,
      highlight: "last",
      threshold: { value: 4.2, label: "avg $4.20" },
    });
    assertSound("highlight", svg);
    expect(svg).toContain('stop-opacity="0.95"'); // highlighted bar
    expect(svg).toContain(
      `stop-opacity="${(0.95 * THEME.opacity.dim).toFixed(3).replace(/0+$/, "")}"`,
    );
    expect(svg).toContain("stroke-dasharray");
    expect(svg).toContain("avg $4.20");
  });

  it("labels:false shows y tick labels instead of value labels", () => {
    const svg = barChart({ items, format: usd, labels: false });
    assertSound("nolabels", svg);
    expect(svg).not.toContain(">$7.00<");
    expect(svg).toContain(">$0.00<");
  });

  it("negative values hang below the zero line", () => {
    const svg = barChart({
      items: [
        { label: "a", value: 4 },
        { label: "b", value: -2.5 },
      ],
    });
    assertSound("negative bars", svg);
    expect(svg).toContain(">−2.5<");
  });

  it("stacked segments are clipped to one rounded bar", () => {
    const svg = barChart({
      items: [
        {
          label: "a",
          value: 0,
          segments: [
            { value: 3, color: C.blue },
            { value: 2, color: C.purple },
          ],
        },
      ],
    });
    assertSound("stacked", svg);
    expect(svg).toContain("<clipPath");
    expect(svg.match(/<rect[^>]*fill="raycast-/g)).toHaveLength(2);
  });

  it("horizontal: label, value and a thin bar per row, longest for the max", () => {
    const svg = barChart({
      orientation: "horizontal",
      format: usd,
      items: [
        { label: "claude-code", value: 4 },
        { label: "codex", value: 1 },
      ],
    });
    assertSound("horizontal", svg);
    expect(svg).toContain("claude-code");
    expect(svg).toContain(">$1.00<");
    expect(svg.match(/<rect/g)).toHaveLength(4); // 2 tracks + 2 fills
  });

  it("many bars label only what fits; empty and non-finite input are safe", () => {
    const many = dailySpend({ days: 30 }).map((value, i) => ({
      label: String(i + 1),
      value,
    }));
    const svg = barChart({ items: many, highlight: "last" });
    assertSound("30 bars", svg);
    expect(svg.match(/font-size="12"/g)!.length).toBeLessThan(40);
    assertSound("empty", barChart({ items: [] }));
    assertSound("empty h", barChart({ items: [], orientation: "horizontal" }));
    const broken = [
      { label: "ok", value: 4 },
      { label: "broken", value: NaN },
    ];
    assertSound("nan", barChart({ items: broken }));
    const horizontal = barChart({ items: broken, orientation: "horizontal" });
    assertSound("nan h", horizontal);
    expect(horizontal).toContain(">—<");
    assertSound("zeros", barChart({ items: [{ label: "z", value: 0 }] }));
  });
});

describe("thresholdBar", () => {
  it("fills proportionally, colours by threshold, labels both ends", () => {
    const svg = thresholdBar({
      label: "Today",
      percent: 30,
      valueText: "$4.20",
    });
    assertSound("thresholdBar", svg);
    expect(svg).toContain("Today");
    expect(svg).toContain("$4.20");
    expect(svg).toContain(C.green);
    expect(thresholdBar({ label: "x", percent: 95, valueText: "" })).toContain(
      C.red,
    );
    expect(
      thresholdBar({ label: "x", percent: 95, valueText: "", invert: true }),
    ).toContain(C.green);
  });

  it("clamps and survives non-finite percent", () => {
    for (const percent of [-10, 0, 100, 250, NaN]) {
      assertSound(
        `bar ${percent}`,
        thresholdBar({ label: "x", percent, valueText: "v" }),
      );
    }
  });
});

describe("rings", () => {
  it("track + rounded value arc, label, sublabel, centre number", () => {
    const svg = ringGaugeRow([
      { percent: 60, label: "5h", sublabel: "resets in 2h" },
      { percent: 91, label: "7d" },
    ]);
    assertSound("rings", svg);
    expect(svg.match(/<circle/g)).toHaveLength(2); // tracks
    expect(svg.match(/<path d="M/g)).toHaveLength(2); // value arcs
    expect(svg).toContain(">60%<");
    expect(svg).toContain("resets in 2h");
    expect(svg).toContain(C.orange); // 60%
    expect(svg).toContain(C.red); // 91%
  });

  it("explicit colour, valueText and the single-ring shortcut", () => {
    const svg = ring({
      percent: 10,
      label: "x",
      color: C.purple,
      valueText: "138",
    });
    expect(svg).toContain(C.purple);
    expect(svg).toContain(">138<");
  });

  it("0% draws only the track; 100% a full ring; NaN is 0", () => {
    expect(ring({ percent: 0, label: "x" })).not.toContain("<path");
    assertSound("full", ring({ percent: 100, label: "x" }));
    const nan = ring({ percent: NaN, label: "x" });
    assertSound("nan ring", nan);
    expect(nan).toContain(">0%<");
  });

  it("a long headline shrinks to fit but never below the 20pt floor", () => {
    const svg = ringGaugeRow(
      [{ percent: 50, label: "x", valueText: "1234.5 Mbps" }],
      { width: 226, height: 170 },
    );
    assertLegibleAtColumn("long value", svg);
  });
});

describe("menuBarRing", () => {
  it("track + arc, no text (nothing reads at 18pt)", () => {
    const svg = menuBarRing({ percent: 42 });
    assertSound("menuBarRing", svg);
    expect(svg).not.toContain("<text");
    expect(svg).toContain("<path");
    expect(menuBarRing({ percent: 90, invert: true })).toContain(C.green);
    expect(menuBarRing({ percent: NaN })).not.toContain("NaN");
  });
});

describe("glyphs", () => {
  it("batteryGlyph: percent, limit marker, charging bolt, watts", () => {
    const svg = batteryGlyph({
      percent: 76,
      limitPercent: 80,
      charging: true,
      wattsLabel: "12 W",
    });
    assertSound("battery", svg);
    expect(svg).toContain(">76%<");
    expect(svg).toContain("80% limit");
    expect(svg).toContain("12 W");
    expect(svg).toContain("<path"); // bolt
    expect(batteryGlyph({ percent: 50 })).not.toContain("<path");
    for (const percent of [-5, 0, 100, 140, NaN]) {
      assertSound(`battery ${percent}`, batteryGlyph({ percent }));
    }
  });

  it("signalBars fills a proportional number of bars, at least one", () => {
    const full = signalBars({ percent: 100, bars: 5, label: "4G+" });
    assertSound("signal", full);
    expect(full.match(/<rect/g)).toHaveLength(5);
    expect(full).toContain("4G+");
    expect(full.match(/fill-opacity="1"/g)).toHaveLength(5);
    expect(signalBars({ percent: 0 }).match(/fill-opacity="1"/g)).toHaveLength(
      1,
    );
    assertSound("signal nan", signalBars({ percent: NaN }));
  });

  it("tile: glyph, name, status, colour, optional trend", () => {
    const svg = tile({ glyph: "T", name: "Tasks", status: "3 overdue" });
    assertSound("tile", svg);
    expect(svg).toContain(">T<");
    expect(svg).toContain("3 overdue");
    expect(svg).toContain(C.blue);
    expect(svg).not.toContain('stroke-width="1.75"');
    const trend = tile({
      glyph: "S",
      name: "Speed",
      status: "138 Mbps",
      color: C.green,
      trend: [60, 80, 70, 138],
    });
    assertSound("tile trend", trend);
    expect(trend).toContain('stroke-width="1.75"');
    assertSound(
      "tile one",
      tile({ glyph: "S", name: "x", status: "y", trend: [1] }),
    );
  });

  it("heroColumns places N pre-rendered heroes side by side", () => {
    const a = svgDocument(100, 50, "<rect id='a'/>");
    const b = svgDocument(100, 80, "<rect id='b'/>");
    const svg = heroColumns([a, b], { width: 300 });
    expect(svg).toContain('width="300"');
    expect(svg).toContain('height="80"');
    expect(svg).toContain("id='a'");
    expect(svg.match(/<g transform="translate/g)).toHaveLength(2);
    expect(heroColumns([svgDocument(50, 50, "<rect/>")])).toContain(
      `width="${HERO_COL_WIDTH}"`,
    );
  });
});

const heightOf = (svg: string) => Number(svg.match(/height="([\d.]+)"/)![1]);

describe("statCards", () => {
  const card = (i: number): StatCard => ({
    label: `Card ${i}`,
    value: i * 10,
    unit: "W",
    sub: `sub ${i}`,
  });
  const cards = (count: number) =>
    Array.from({ length: count }, (_, i) => card(i + 1));
  const ROW = 82; // a strip with sub lines
  const COMPACT_ROW = 56;

  it("lays 1–8 cards out on a hairline grid at the column width, sound and legible", () => {
    const rowsFor = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 2, 6: 2, 7: 2, 8: 2 } as const;
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const svg = statCards({ cards: cards(count) });
      assertSound(`cards ${count}`, svg);
      assertLegibleAtColumn(`cards ${count}`, svg);
      expect(svg).toContain(`width="${HERO_COL_WIDTH}"`);
      expect(heightOf(svg)).toBe(rowsFor[count] * ROW);
      for (let i = 1; i <= count; i++) expect(svg).toContain(`>${i * 10}<`);
    }
  });

  it("is drawn with hairlines only: no filled or rounded boxes", () => {
    const svg = statCards({ cards: cards(4), columns: 2 });
    expect(svg).not.toContain("<rect");
    // top + bottom of each of 2 rows, plus a divider per row
    expect(svg.match(/<line /g)).toHaveLength(3 + 2);
  });

  it("columns are overridable and clamped; width is overridable", () => {
    expect(heightOf(statCards({ cards: cards(4), columns: 2 }))).toBe(2 * ROW);
    expect(heightOf(statCards({ cards: cards(4), columns: 99 }))).toBe(ROW);
    expect(heightOf(statCards({ cards: cards(2), columns: 0 }))).toBe(2 * ROW);
    expect(statCards({ cards: cards(2), width: 300 })).toContain('width="300"');
  });

  it("compact: one short row, no sub line or sparkline, up to six columns", () => {
    const svg = statCards({
      size: "compact",
      columns: 5,
      cards: [...cards(5)].map((c) => ({ ...c, trend: [1, 2, 3] })),
    });
    assertSound("cards compact", svg);
    assertLegibleAtColumn("cards compact", svg);
    expect(heightOf(svg)).toBe(COMPACT_ROW);
    expect(svg).not.toContain("sub 1");
    expect(svg).not.toContain('stroke-width="1.75"');
    expect(
      heightOf(statCards({ size: "compact", cards: cards(12), columns: 9 })),
    ).toBe(2 * COMPACT_ROW);
  });

  it("missing / NaN values show an em dash and drop the unit", () => {
    const svg = statCards({
      cards: [
        { label: "A", value: undefined, unit: "kWh" },
        { label: "B", value: NaN, unit: "kWh" },
        { label: "C", value: null, unit: "kWh" },
      ],
    });
    assertSound("cards missing", svg);
    expect(svg.match(/>—</g)).toHaveLength(3);
    expect(svg).not.toContain("kWh");
  });

  it("formats numbers compactly and keeps string values verbatim", () => {
    const svg = statCards({
      cards: [
        { label: "n", value: 12.345 },
        { label: "s", value: "−4.1" },
        { label: "z", value: 0 },
      ],
    });
    expect(svg).toContain(">12.3<");
    expect(svg).toContain(">−4.1<");
    expect(svg).toContain(">0<");
  });

  it("truncates a long label, value and sub with an ellipsis; a long value shrinks first", () => {
    const svg = statCards({
      columns: 4,
      cards: [
        {
          label: "An extremely long label that cannot fit",
          value: "1234567890123456",
          unit: "kWh",
          sub: "a sub line far too long for a quarter-width card",
          delta: { value: "12.5 kWh", direction: "up", good: true },
        },
        { label: "Word", value: "Discharging" },
        card(3),
        card(4),
      ],
    });
    assertSound("cards long", svg);
    assertLegibleAtColumn("cards long", svg);
    expect(svg).not.toContain("An extremely long label that cannot fit");
    expect(svg).not.toContain("1234567890123456<");
    expect(svg).not.toContain(
      "a sub line far too long for a quarter-width card",
    );
    expect(svg.match(/…/g)!.length).toBeGreaterThanOrEqual(3);
    expect(svg).toContain(">Discharging<"); // shrunk, not cut
  });

  it("tone is a dot in the semantic colour after the label; neutral has none", () => {
    const dot = (tone: StatCard["tone"]) =>
      statCards({ cards: [{ label: "x", value: 1, tone }] });
    expect(dot("good")).toContain(`<circle`);
    expect(dot("good")).toContain(`fill="${C.green}"`);
    expect(dot("warn")).toContain(`fill="${C.orange}"`);
    expect(dot("bad")).toContain(`fill="${C.red}"`);
    expect(dot("accent")).toContain(`fill="${C.blue}"`);
    expect(dot("neutral")).not.toContain("<circle");
    expect(dot(undefined)).not.toContain("<circle");
  });

  it("delta is coloured by `good`, muted when omitted; trend needs 2+ points", () => {
    const delta = (good?: boolean) =>
      statCards({
        cards: [
          {
            label: "x",
            value: 1,
            delta: { value: "2", direction: "down", good },
          },
        ],
      });
    expect(delta(true)).toContain(`fill="${C.green}"`);
    expect(delta(false)).toContain(`fill="${C.red}"`);
    expect(delta()).toContain("▼ 2");
    expect(delta()).not.toContain(`fill="${C.green}"`);
    const spark = (trend: number[]) =>
      statCards({
        cards: [{ label: "x", value: 1, trend, trendColor: C.yellow }],
      });
    assertSound("cards trend", spark([1, 3, 2, 5]));
    expect(spark([1, 3, 2, 5])).toContain('stroke-width="1.75"');
    expect(spark([1, 3, 2, 5])).toContain(C.yellow);
    expect(spark([1])).not.toContain('stroke-width="1.75"');
  });

  it("no cards: a placeholder, not a broken image", () => {
    const svg = statCards({ cards: [] });
    assertSound("cards empty", svg);
    expect(svg).toContain("No data yet");
  });

  it("without any sub line the strip is shorter", () => {
    expect(
      heightOf(statCards({ cards: [{ label: "x", value: 1 }] })),
    ).toBeLessThan(ROW);
  });

  it("escapes markup in labels", () => {
    const svg = statCards({ cards: [{ label: "<b>&", value: "1" }] });
    expect(svg).toContain("&lt;B&gt;&amp;");
  });
});

describe("statusPanel", () => {
  const battery = {
    label: "Battery",
    value: 82,
    unit: "%",
    percent: 82,
    gauge: "battery" as const,
    color: C.green,
    marker: 80,
    sub: "−4.1 A · empty in ~39h · 13.42 V",
  };
  const solar = {
    label: "Solar",
    value: 148,
    unit: "W",
    percent: 70,
    color: C.yellow,
    sub: "Bulk · 1.24 kWh today",
  };

  it("two headline columns with gauge and sub line, sound and legible", () => {
    const svg = statusPanel({ columns: [battery, solar] });
    assertSound("panel", svg);
    assertLegibleAtColumn("panel", svg);
    expect(heightOf(svg)).toBe(124);
    expect(svg).toContain(">BATTERY<");
    expect(svg).toContain(">82<");
    expect(svg).toContain(">148<");
    expect(svg).toContain("empty in ~39h");
    expect(svg).not.toContain('<rect x="0.5"'); // no card background
    expect(svg.match(/<line /g)!.length).toBeGreaterThanOrEqual(2); // divider + limit tick
  });

  it("one to three columns; extra columns are dropped; none is a placeholder", () => {
    assertSound("panel one", statusPanel({ columns: [battery] }));
    const three = statusPanel({ columns: [battery, solar, battery, solar] });
    expect(three.match(/>BATTERY</g)).toHaveLength(2); // battery, solar, battery
    expect(statusPanel({ columns: [] })).toContain("No data yet");
  });

  it("missing value shows an em dash; gauge optional; percent clamped", () => {
    const svg = statusPanel({
      columns: [
        { label: "A", value: null },
        { label: "B", value: 5, percent: 250, color: C.blue },
        { label: "C", value: 5, percent: NaN },
      ],
    });
    assertSound("panel missing", svg);
    assertLegibleAtColumn("panel missing", svg);
    expect(svg).toContain(">—<");
  });

  it("a long value shrinks (never below the 20pt primary floor) and a long sub truncates", () => {
    const svg = statusPanel({
      columns: [
        {
          label: "L",
          value: "1234567890123456789",
          unit: "kWh",
          sub: "x".repeat(120),
        },
        solar,
      ],
    });
    assertSound("panel long", svg);
    assertLegibleAtColumn("panel long", svg);
    expect(svg).toContain("…");
  });
});

describe("barChart extras and time-chart windows", () => {
  it("barChart: sublabel draws a second axis line; labelMode max labels only the tallest; dim:false keeps full strength", () => {
    const bars = Array.from({ length: 14 }, (_, i) => ({
      label: "Mon",
      sublabel: String(i + 1),
      value: (i % 5) * 100 + 100,
    }));
    const spec = {
      items: bars,
      format: (v: number) => `${v} Wh`,
      highlight: "last" as const,
      labelMode: "max" as const,
    };
    const svg = barChart(spec);
    assertSound("bars two-line", svg);
    assertLegibleAtColumn("bars two-line", svg);
    expect(svg).toContain(">14<");
    expect(svg.match(/ Wh</g)).toHaveLength(1); // the tallest only
    const dimmed = barChart(spec);
    const flat = barChart({ ...spec, dim: false });
    expect(dimmed).toContain('stop-opacity="0.589"'); // 0.95 × the 0.62 dim
    expect(flat).not.toContain('stop-opacity="0.589"');
  });

  it("area chart: a fixed domain keeps a 3-day window 3 days wide, with day labels and night shading", () => {
    const end = new Date(2026, 9, 5, 14, 0).getTime();
    const start = end - 3 * D;
    const svg = areaChart({
      domain: [start, end],
      dayAxis: true,
      shading: [
        { from: end - 2 * D - 5 * H, to: end - 2 * D + 2 * H },
        { from: start - H, to: start + H }, // clipped at the left edge
        { from: end + H, to: end + 2 * H }, // outside the window: dropped
      ],
      times: [end - 10 * H, end - 9 * H], // data only in the last hours
      series: [
        {
          label: "S",
          color: C.green,
          values: [50, 60],
          domain: [0, 100],
        },
      ],
    });
    assertSound("window", svg);
    assertLegibleAtColumn("window", svg);
    expect(svg.match(/fill-opacity="0.1"/g)).toHaveLength(2);
    // the data sits at the right end of the window, not stretched across it
    const circle = Number(svg.match(/<circle cx="([\d.]+)"/)![1]);
    expect(circle).toBeGreaterThan(HERO_COL_WIDTH * 0.8);
    // weekday labels, two midnight hairlines inside the window
    for (const day of ["Sat", "Sun", "Mon"]) expect(svg).toContain(`>${day}<`);
    expect(
      svg.match(
        /<line x1="[\d.]+" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+" stroke="raycast-secondary-text" stroke-opacity="0.2" stroke-width="1" \/>/g,
      )!.length,
    ).toBeGreaterThan(2);
  });

  it("area chart: a null between samples breaks the line; an isolated sample is a dot", () => {
    const times = timeAxis({ end: NOW, spanMs: 3 * D, count: 7 });
    const svg = areaChart({
      times,
      series: [{ color: C.green, values: [50, 52, null, 70, null, 40, 41] }],
    });
    assertSound("gaps", svg);
    expect(svg).toContain('r="2.5"'); // the isolated 70
    expect(svg.match(/<path d="M[^"]*" fill="none"/g)).toBeTruthy();
  });

  it("area chart: lastValues:false drops the chip and legend values", () => {
    const times = timeAxis({ end: NOW, spanMs: D, count: 20 });
    const base = {
      times,
      series: [
        {
          label: "S",
          color: C.blue,
          values: times.map((_, i) => 40 + i),
          format: (v: number) => `${v} Q`,
        },
      ],
    };
    expect(areaChart(base)).toContain("59 Q");
    expect(areaChart({ ...base, lastValues: false })).not.toContain("59 Q");
  });
});

// Tinycast beta draws a markdown image at its intrinsic/hinted size and never
// upscales — every hero a command actually embeds is built by the command's
// own function (production-heroes.ts) and held to the floor at the real column
// width: ≥11pt text, ≥20pt for the headline, canvas ≤ HERO_COL_WIDTH.
describe("production heroes", () => {
  const heroes = productionHeroes(NOW);

  it("covers every command that draws charts", () => {
    const groups = new Set(heroes.map((h) => h.group));
    for (const group of ["usage", "speed", "battery", "van", "netgear"]) {
      expect(groups.has(group), group).toBe(true);
    }
    expect(heroes.map((h) => h.name)).toEqual(
      expect.arrayContaining([
        "van-panel",
        "van-charge",
        "van-yield",
        "usage-days",
        "speed-history",
      ]),
    );
  });

  it.each(productionHeroes(NOW).map((h) => [h.name, h.svg] as const))(
    "%s is sound and legible",
    (name, svg) => {
      assertSound(name, svg);
      assertLegibleAtColumn(name, svg);
    },
  );

  it("every status panel and metrics row is drawn at the column width", () => {
    for (const hero of heroes.filter((h) => /-(panel|metrics)/.test(h.name))) {
      expect(hero.svg, hero.name).toContain(`width="${HERO_COL_WIDTH}"`);
    }
  });
});
