import { describe, expect, it } from "vitest";
import {
  ClimatePoint,
  climateHistoryMarkdown,
  climateSummaryLines,
  menuClimateLine,
  parseClimate,
} from "./climate";

const NOW = Date.parse("2026-11-02T22:00:00Z");
const point = (
  minutesAgo: number,
  inT: number | null,
  inH = 40,
): ClimatePoint => ({
  at: NOW - minutesAgo * 60_000,
  inT,
  inH,
  outT: 4.3,
  outH: 81,
});

describe("parseClimate", () => {
  it("maps entries, nulls and drops bad rows", () => {
    const raw = JSON.stringify([
      {
        at: "2026-11-02T21:41:44.265Z",
        in_t: 22.2,
        in_h: 42,
        out_t: null,
        out_h: 81,
      },
      { at: "nope", in_t: 1 },
      "x",
    ]);
    expect(parseClimate(raw)).toEqual([
      {
        at: Date.parse("2026-11-02T21:41:44.265Z"),
        inT: 22.2,
        inH: 42,
        outT: null,
        outH: 81,
      },
    ]);
    expect(parseClimate("oops")).toBeNull();
    expect(parseClimate("{}")).toBeNull();
  });
});

describe("summaries", () => {
  const points = [
    point(2000, 18),
    point(120, 21.4, 40),
    point(60, 22.6, 45),
    point(0, null, 43),
  ];

  it("builds the menu line from the last 24 h only", () => {
    expect(menuClimateLine(points, NOW)).toBe("24 h: 21.4–22.6 °C · 40–45 %");
    expect(menuClimateLine(null, NOW)).toBeNull();
    expect(menuClimateLine([], NOW)).toBeNull();
    expect(menuClimateLine([point(0, null, 43)], NOW)).toBe("24 h: 43–43 %");
  });

  it("gives three summary lines with the latest outside reading", () => {
    expect(climateSummaryLines(points, NOW)).toEqual([
      "Inside temperature, 24 h: 21.4–22.6 °C",
      "Inside humidity, 24 h: 40–45 %",
      "Outside now: 4.3 °C · 81 %",
    ]);
    expect(climateSummaryLines([], NOW)[2]).toBe("Outside now: no data");
  });
});

describe("climateHistoryMarkdown", () => {
  it("says recording started instead of drawing a stub chart", () => {
    const md = climateHistoryMarkdown([point(20, 21), point(10, 21.5)], NOW);
    expect(md).toMatch(/Recording started at .*fills in over the next hours/);
    expect(md).not.toContain("![");
  });

  it("handles no data", () => {
    expect(climateHistoryMarkdown([], NOW)).toMatch(/No climate recorded yet/);
  });

  it("draws both charts with enough points", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      point((12 - i) * 10, 21 + i / 10),
    );
    const md = climateHistoryMarkdown(many, NOW);
    expect(md).toContain("![Temperature](data:");
    expect(md).toContain("![Humidity](data:");
    expect(md).toContain("- Outside now:");
  });
});
