import { describe, it, expect } from "vitest";
import {
  RAYCAST_COLOR,
  HERO_COL_WIDTH,
  clamp,
  escapeXml,
  thresholdColor,
  toDataUri,
  svgDocument,
  computeImageScale,
  assertLegible,
  ringGaugeRow,
  thresholdBar,
  barChart,
  sparkline,
  batteryGlyph,
  signalBars,
  menuBarRing,
  tile,
} from "./svg";

describe("clamp", () => {
  it("clamps into range", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(42, 0, 100)).toBe(42);
  });
});

describe("escapeXml", () => {
  it("escapes the five XML-significant characters used here", () => {
    expect(escapeXml(`<a> & "b" it's`)).toBe(
      "&lt;a&gt; &amp; &quot;b&quot; it's",
    );
  });
});

describe("thresholdColor", () => {
  it("is green below 50, orange below 80, red at/above 80 by default", () => {
    expect(thresholdColor(0)).toBe(RAYCAST_COLOR.green);
    expect(thresholdColor(49)).toBe(RAYCAST_COLOR.green);
    expect(thresholdColor(50)).toBe(RAYCAST_COLOR.orange);
    expect(thresholdColor(79)).toBe(RAYCAST_COLOR.orange);
    expect(thresholdColor(80)).toBe(RAYCAST_COLOR.red);
    expect(thresholdColor(100)).toBe(RAYCAST_COLOR.red);
  });

  it("inverts to red-low / green-high", () => {
    expect(thresholdColor(10, { invert: true })).toBe(RAYCAST_COLOR.red);
    expect(thresholdColor(60, { invert: true })).toBe(RAYCAST_COLOR.orange);
    expect(thresholdColor(90, { invert: true })).toBe(RAYCAST_COLOR.green);
  });

  it("accepts custom low/high boundaries — radio quality's 35/60 split", () => {
    expect(
      thresholdColor(34, { invert: true, lowBoundary: 35, highBoundary: 60 }),
    ).toBe(RAYCAST_COLOR.red);
    expect(
      thresholdColor(48, { invert: true, lowBoundary: 35, highBoundary: 60 }),
    ).toBe(RAYCAST_COLOR.orange);
    expect(
      thresholdColor(60, { invert: true, lowBoundary: 35, highBoundary: 60 }),
    ).toBe(RAYCAST_COLOR.green);
  });
});

describe("toDataUri", () => {
  it("produces a base64 data: URI Tinycast decodes as an inline SVG", () => {
    const uri = toDataUri(svgDocument(10, 10, "<rect/>"));
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
    const [, base64WithHint] = uri.split(";base64,");
    const [base64] = base64WithHint.split("?");
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    expect(decoded).toContain("<rect/>");
  });

  it("appends a raycast-width/height hint matching the SVG's own size", () => {
    const uri = toDataUri(svgDocument(320, 90, "<rect/>"));
    expect(uri).toContain("?raycast-width=320&raycast-height=90");
  });
});

describe("svgDocument", () => {
  it("wraps body in a sized, viewBox-ed <svg>", () => {
    const svg = svgDocument(900, 220, "<circle/>");
    expect(svg).toContain('width="900"');
    expect(svg).toContain('height="220"');
    expect(svg).toContain('viewBox="0 0 900 220"');
    expect(svg).toContain("<circle/>");
  });
});

describe("ringGaugeRow", () => {
  it("draws two arcs (track + value) and both labels per gauge", () => {
    const svg = ringGaugeRow([
      { percent: 60, label: "5h", sublabel: "resets in 2h" },
      { percent: 91, label: "7d" },
    ]);
    expect(svg.match(/<circle/g)?.length).toBe(4);
    expect(svg).toContain("60%");
    expect(svg).toContain("91%");
    expect(svg).toContain("5h");
    expect(svg).toContain("resets in 2h");
    expect(svg).toContain(RAYCAST_COLOR.orange); // 60% -> orange
    expect(svg).toContain(RAYCAST_COLOR.red); // 91% -> red
  });

  it("respects an explicit color override", () => {
    const svg = ringGaugeRow([
      { percent: 10, label: "x", color: RAYCAST_COLOR.purple },
    ]);
    expect(svg).toContain(RAYCAST_COLOR.purple);
  });
});

describe("thresholdBar", () => {
  it("fills proportionally and labels both ends", () => {
    const svg = thresholdBar({
      label: "Today",
      percent: 30,
      valueText: "$4.20",
    });
    expect(svg).toContain("Today");
    expect(svg).toContain("$4.20");
    expect(svg).toContain(RAYCAST_COLOR.green);
  });
});

describe("barChart", () => {
  it("draws one row per item, longest bar for the max value", () => {
    const svg = barChart([
      { label: "claude-code", value: 4 },
      { label: "codex", value: 1 },
    ]);
    expect(svg).toContain("claude-code");
    expect(svg).toContain("codex");
    expect(svg.match(/<rect/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("handles an empty list without dividing by zero", () => {
    expect(() => barChart([])).not.toThrow();
  });
});

describe("sparkline", () => {
  it("draws a line, an area, and labels the first/last value", () => {
    const svg = sparkline({ values: [1, 5, 2, 8, 3] });
    expect(svg).toContain("<path");
    expect(svg).toContain("1.00");
    expect(svg).toContain("3.00");
  });

  it("handles a single value without NaN coordinates", () => {
    const svg = sparkline({ values: [5] });
    expect(svg).not.toContain("NaN");
  });

  it("handles an empty array without NaN coordinates", () => {
    const svg = sparkline({ values: [] });
    expect(svg).not.toContain("NaN");
  });
});

describe("batteryGlyph", () => {
  it("shows the percent, a limit marker, and a charging bolt", () => {
    const svg = batteryGlyph({
      percent: 76,
      limitPercent: 80,
      charging: true,
      wattsLabel: "12 W",
    });
    expect(svg).toContain("76%");
    expect(svg).toContain("12 W");
    expect(svg).toContain("stroke-dasharray"); // limit marker
    expect(svg).toContain("<path"); // bolt
  });

  it("omits the bolt when not charging", () => {
    const svg = batteryGlyph({ percent: 50 });
    expect(svg).not.toContain("<path");
  });
});

describe("tile", () => {
  it("shows the glyph, name, and status", () => {
    const svg = tile({ glyph: "T", name: "Tasks", status: "3 overdue" });
    expect(svg).toContain(">T<");
    expect(svg).toContain("Tasks");
    expect(svg).toContain("3 overdue");
    expect(svg).toContain(RAYCAST_COLOR.blue);
  });

  it("respects an explicit color", () => {
    const svg = tile({
      glyph: "B",
      name: "Battery",
      status: "76%",
      color: RAYCAST_COLOR.green,
    });
    expect(svg).toContain(RAYCAST_COLOR.green);
  });
});

describe("signalBars", () => {
  it("fills a proportional number of bars", () => {
    const svg = signalBars({ percent: 100, bars: 5, label: "4G+" });
    expect(svg.match(/<rect/g)?.length).toBe(5);
    expect(svg).toContain("4G+");
  });

  it("always fills at least one bar", () => {
    const svg = signalBars({ percent: 0, bars: 5 });
    expect(svg).toContain(RAYCAST_COLOR.secondaryText);
  });
});

describe("menuBarRing", () => {
  it("draws a track arc and a value arc, no text (nothing reads at 18pt)", () => {
    const svg = menuBarRing({ percent: 42 });
    expect(svg.match(/<circle/g)?.length).toBe(2);
    expect(svg).not.toContain("<text");
  });

  it("respects invert for a signal-quality reading", () => {
    const svg = menuBarRing({ percent: 90, invert: true });
    expect(svg).toContain(RAYCAST_COLOR.green);
  });
});

describe("computeImageScale", () => {
  it("is 1 when the canvas already fits the column", () => {
    expect(computeImageScale(680, 680)).toBe(1);
    expect(computeImageScale(680, 400)).toBe(1);
  });

  it("shrinks proportionally when the canvas is wider than the column", () => {
    expect(computeImageScale(400, 800)).toBeCloseTo(0.5, 5);
  });
});

// Tinycast beta/main draws a markdown image at its intrinsic/hinted size and
// never upscales (no 220pt cap, unlike stable 0.11.3) — see svg.ts's header
// comment. Every hero this extension actually embeds is exercised here at
// HERO_COL_WIDTH (the real target column width, full-width Detail views
// with no Detail.Metadata sidebar) to catch any future regression where a
// canvas grows wider than its column or a font shrinks below the floor.
describe("Hero image legibility at real render size", () => {
  function check(name: string, svg: string, svgWidth: number) {
    const violations = assertLegible(svg, HERO_COL_WIDTH, svgWidth);
    expect(violations, `${name}: ${violations.join("; ")}`).toEqual([]);
  }

  it("usage: three quota rings", () => {
    const svg = ringGaugeRow([
      { percent: 62, label: "5h", sublabel: "resets in 2h 14m" },
      { percent: 88, label: "7d", sublabel: "resets in 3d 4h" },
      { percent: 34, label: "7d Sonnet", sublabel: "resets in 3d 4h" },
    ]);
    check("usage rings", svg, HERO_COL_WIDTH);
  });

  it("usage: spend bar chart, 5 lanes + other", () => {
    const svg = barChart(
      [
        { label: "claude-code", value: 4.82 },
        { label: "codex", value: 2.1 },
        { label: "opencode", value: 1.4 },
        { label: "warden", value: 0.92 },
        { label: "sideclaw", value: 0.61 },
        { label: "other", value: 0.55 },
      ],
      { formatValue: (v) => `$${v.toFixed(2)}` },
    );
    check("usage spend bars", svg, HERO_COL_WIDTH);
  });

  it("usage: 7-day sparkline", () => {
    const svg = sparkline({
      values: [3.2, 5.1, 2.8, 6.4, 4.9, 7.2, 5.5],
      formatValue: (v) => `$${v.toFixed(2)}`,
    });
    check("usage sparkline", svg, HERO_COL_WIDTH);
  });

  it("battery: glyph + health bar", () => {
    check(
      "battery glyph",
      batteryGlyph({
        percent: 76,
        limitPercent: 80,
        charging: true,
        wattsLabel: "-7 W",
      }),
      HERO_COL_WIDTH,
    );
    check(
      "battery health bar",
      thresholdBar({
        label: "Health",
        percent: 86,
        valueText: "86% · 348 cycles",
        invert: true,
      }),
      HERO_COL_WIDTH,
    );
  });

  it("netgear: signal bars, radio gauge, battery glyph", () => {
    check(
      "netgear signal",
      signalBars({ percent: 76, bars: 5, label: "4G+" }),
      HERO_COL_WIDTH,
    );
    check(
      "netgear radio gauge",
      ringGaugeRow([
        {
          percent: 48,
          label: "Radio Quality",
          sublabel: "LTE B3 · Orange (roaming)",
          invert: true,
          lowBoundary: 35,
          highBoundary: 60,
        },
      ]),
      HERO_COL_WIDTH,
    );
    check(
      "netgear battery",
      batteryGlyph({ percent: 66, charging: true }),
      HERO_COL_WIDTH,
    );
  });

  it("speed test: single (quick) and dual (full) gauges", () => {
    check(
      "speed single gauge",
      ringGaugeRow([
        {
          percent: 43,
          label: "Download",
          valueText: "65",
          sublabel: "Mbps",
          color: RAYCAST_COLOR.blue,
        },
      ]),
      HERO_COL_WIDTH,
    );
    check(
      "speed dual gauge",
      ringGaugeRow([
        {
          percent: 58,
          label: "Download",
          valueText: "138",
          sublabel: "Mbps",
          color: RAYCAST_COLOR.blue,
        },
        {
          percent: 15,
          label: "Upload",
          valueText: "25",
          sublabel: "Mbps",
          color: RAYCAST_COLOR.purple,
        },
      ]),
      HERO_COL_WIDTH,
    );
    check(
      "speed sparkline",
      sparkline({
        values: [40, 65, 52, 90, 138],
        formatValue: (v) => `${v.toFixed(0)} Mbps`,
      }),
      HERO_COL_WIDTH,
    );
  });
});
