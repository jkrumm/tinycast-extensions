import { describe, expect, it } from "vitest";
import { climateMarkdown } from "./climate-view";
import { climateFixture, statusCacheFixture } from "./fixtures";
import { metricCards, panelColumns } from "./heroes";

const NOW = Date.UTC(2026, 10, 2, 14, 30);
const status = statusCacheFixture(NOW);

describe("climateMarkdown", () => {
  it("draws the panel, metrics and both charts with enough history", () => {
    const points = climateFixture({ end: NOW, hours: 48 });
    const md = climateMarkdown({ status, points, range: "48h", now: NOW });
    for (const image of ["Status", "Metrics", "Temperature", "Humidity"])
      expect(md).toContain(`![${image}](data:`);
    expect(md).toContain("_Updated 3 min ago_");
    expect(md).toContain("Temperature · last 48 h");
  });

  it("says recording started instead of drawing a stub chart", () => {
    const points = climateFixture({ end: NOW, hours: 0.5 });
    const md = climateMarkdown({ status, points, range: "48h", now: NOW });
    expect(md).toMatch(/Recording started at .*fills in over the next hours/);
    expect(md).not.toContain("![Temperature]");
    expect(md).toContain("![Status]");
  });

  it("handles no history and no status", () => {
    const md = climateMarkdown({
      status: null,
      points: [],
      range: "24h",
      now: NOW,
    });
    expect(md).toContain("No climate recorded yet.");
    expect(md).not.toContain("_Updated");
  });

  it("downsamples the 30 d range", () => {
    const points = climateFixture({ end: NOW, hours: 720 });
    const md = climateMarkdown({ status, points, range: "30d", now: NOW });
    expect(md).toContain("Temperature · last 30 days");
  });
});

describe("panel and metrics content", () => {
  const points = climateFixture({ end: NOW, hours: 48 });

  it("shows the live inside reading, the humidity hint and outside", () => {
    const cols = panelColumns({ status, points, now: NOW });
    expect(cols.map((c) => c.label)).toEqual(["Inside", "Humidity", "Outside"]);
    expect(cols[0]).toMatchObject({
      value: "21.9",
      sub: "Eve Room · battery 100 %",
    });
    expect(cols[1]).toMatchObject({ value: "42", sub: "comfortable" });
    expect(cols[2].value).not.toBeNull();
  });

  it("falls back to the last recorded point without status", () => {
    const cols = panelColumns({ status: null, points, now: NOW });
    expect(cols[0].value).toBe(points[points.length - 1].inT?.toFixed(1));
  });

  it("flags an unreachable sensor", () => {
    const stale = {
      ...status,
      status: {
        ...status.status,
        climate: { ...status.status.climate!, reachable: false },
      },
    };
    expect(panelColumns({ status: stale, points, now: NOW })[0].sub).toMatch(
      /unreachable/,
    );
  });

  it("builds six metric cards incl. Nami and presence", () => {
    const cards = metricCards({ status, points, now: NOW });
    expect(cards.map((c) => c.label)).toEqual([
      "Temp · 24 h",
      "Humidity · 24 h",
      "Water in / out",
      "Airing helps",
      "Nami",
      "Someone home",
    ]);
    expect(cards[4].value).toBe("Home");
    expect(cards[5].value).toBe("Yes");
    const none = metricCards({ status: null, points: [], now: NOW });
    expect(none.every((c) => c.value === "—" || c.value == null)).toBe(true);
  });
});
