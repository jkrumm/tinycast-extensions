import { describe, expect, it } from "vitest";
import {
  ClimatePoint,
  absoluteHumidity,
  airing,
  climateStats,
  downsample,
  menuClimateLine,
  parseClimate,
  rangeHours,
  rangeLabel,
  shapeForRange,
} from "./climate";

const NOW = Date.parse("2026-11-02T22:00:00Z");
const HOUR = 3_600_000;
const point = (
  minutesAgo: number,
  inT: number | null,
  inH: number | null = 40,
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

describe("ranges", () => {
  it("maps ranges to hours and labels", () => {
    expect(rangeHours("48h")).toBe(48);
    expect(rangeHours("30d")).toBe(720);
    expect(rangeLabel("24h")).toBe("24 h");
    expect(rangeLabel("7d")).toBe("7 days");
  });

  it("averages buckets and skips nulls", () => {
    const a = { at: 0, inT: 20, inH: null, outT: 1, outH: 80 };
    const b = { at: 600_000, inT: 22, inH: null, outT: null, outH: 90 };
    const c = { at: 2 * HOUR, inT: 10, inH: 50, outT: 0, outH: 70 };
    const out = downsample([a, b, c], HOUR);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      at: 300_000,
      inT: 21,
      inH: null,
      outT: 1,
      outH: 85,
    });
    expect(out[1].inT).toBe(10);
  });

  it("windows 48 h as recorded and thins 7 d / 30 d", () => {
    const many = Array.from({ length: 720 * 6 }, (_, i) => point(i * 10, 21));
    expect(shapeForRange(many, "24h", NOW)).toHaveLength(145);
    expect(shapeForRange(many, "48h", NOW)).toHaveLength(289);
    expect(shapeForRange(many, "7d", NOW)).toHaveLength(169);
    expect(shapeForRange(many, "30d", NOW).length).toBeLessThanOrEqual(181);
    expect(shapeForRange(many, "30d", NOW).length).toBeGreaterThan(150);
  });
});

describe("stats", () => {
  const points = [
    point(2000, 18),
    point(120, 21.4, 40),
    point(60, 22.6, 45),
    point(0, null, 43),
  ];

  it("takes 24 h extents and the latest readings", () => {
    const s = climateStats(points, NOW);
    expect(s.inT).toEqual({ min: 21.4, max: 22.6 });
    expect(s.inH).toEqual({ min: 40, max: 45 });
    expect(s.inTNow).toBe(22.6);
    expect(s.inHNow).toBe(43);
    expect(s.outTNow).toBe(4.3);
    expect(s.outHNow).toBe(81);
    expect(climateStats([], NOW).inT).toBeNull();
  });

  it("builds the menu line from the last 24 h only", () => {
    expect(menuClimateLine(points, NOW)).toBe("24 h: 21.4–22.6 °C · 40–45 %");
    expect(menuClimateLine(null, NOW)).toBeNull();
    expect(menuClimateLine([], NOW)).toBeNull();
    expect(menuClimateLine([point(0, null, 43)], NOW)).toBe("24 h: 43–43 %");
  });
});

describe("absolute humidity", () => {
  it("matches the Magnus reference values", () => {
    expect(absoluteHumidity(20, 50)).toBeCloseTo(8.6, 1);
    expect(absoluteHumidity(0, 100)).toBeCloseTo(4.85, 1);
  });

  it("says airing helps only when outside is at least 1 g/m³ drier", () => {
    const dry = airing(22, 60, 5, 60); // cold air holds little water
    expect(dry?.helps).toBe(true);
    const wet = airing(22, 40, 18, 90);
    expect(wet?.helps).toBe(false);
    expect(airing(22, null, 5, 60)).toBeNull();
  });
});
