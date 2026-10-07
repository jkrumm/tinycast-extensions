import { describe, it, expect } from "vitest";
import {
  RAYCAST_COLOR as C,
  areaChart,
  barChart,
  batteryGlyph,
  lineChart,
  menuBarRing,
  ringGaugeRow,
  signalBars,
  sparkline,
  statCards,
  thresholdBar,
  tile,
  toDataUri,
} from "../svg";
import { dailySpend, vanFixture } from "./fixtures";

// Each hero is rendered 1000× and timed. The target is < ~2 ms per render
// (a command draws a handful per open); the assertion is a loose 10 ms so a
// loaded machine can't flake it. Run `bunx vitest run src/lib/chart/bench.test.ts`
// to see the table.
const RUNS = 1000;
const NOW = Date.UTC(2026, 9, 5, 14, 30);
const van = vanFixture({ end: NOW, hours: 72, count: 170 });
const days = dailySpend({ days: 7 }).map((value, i) => ({
  label: `d${i}`,
  value,
}));

const cases: Array<[string, () => string]> = [
  [
    "areaChart 72h × 170 pts",
    () =>
      areaChart({
        times: van.times,
        series: [
          {
            label: "Solar",
            color: C.yellow,
            values: van.solarW,
            extrema: true,
          },
        ],
      }),
  ],
  [
    "areaChart dual axis",
    () =>
      areaChart({
        times: van.times,
        series: [
          { label: "Solar", color: C.yellow, values: van.solarW },
          {
            label: "Battery",
            color: C.blue,
            values: van.batteryA,
            fill: false,
          },
        ],
      }),
  ],
  [
    "lineChart 72h",
    () =>
      lineChart({
        times: van.times,
        series: [{ color: C.green, values: van.soc, domain: [0, 100] }],
      }),
  ],
  [
    "barChart vertical × 7",
    () =>
      barChart({
        items: days,
        highlight: "last",
        threshold: { value: 4, label: "avg" },
      }),
  ],
  [
    "barChart horizontal × 6",
    () => barChart({ orientation: "horizontal", items: days.slice(0, 6) }),
  ],
  ["sparkline × 170", () => sparkline({ values: van.soc })],
  [
    "ringGaugeRow × 3",
    () =>
      ringGaugeRow([
        { percent: 62, label: "5h" },
        { percent: 88, label: "7d" },
        { percent: 34, label: "7d S" },
      ]),
  ],
  [
    "thresholdBar",
    () =>
      thresholdBar({
        label: "Health",
        percent: 86,
        valueText: "86%",
        invert: true,
      }),
  ],
  [
    "batteryGlyph",
    () =>
      batteryGlyph({
        percent: 76,
        limitPercent: 80,
        charging: true,
        wattsLabel: "22 W",
      }),
  ],
  ["signalBars", () => signalBars({ percent: 76, label: "4G+" })],
  ["menuBarRing", () => menuBarRing({ percent: 62 })],
  [
    "tile + trend",
    () => tile({ glyph: "V", name: "Van", status: "82%", trend: van.soc }),
  ],
  [
    "statCards × 8 + trends",
    () =>
      statCards({
        cards: Array.from({ length: 8 }, (_, i) => ({
          label: `Card ${i}`,
          value: i * 12.5,
          unit: "W",
          sub: "a sub line",
          tone: "good" as const,
          trend: i % 2 ? van.soc : undefined,
        })),
      }),
  ],
  [
    "areaChart + toDataUri",
    () =>
      toDataUri(
        areaChart({
          times: van.times,
          series: [{ color: C.yellow, values: van.solarW }],
        }),
      ),
  ],
];

describe("render cost", () => {
  it("every primitive renders in well under 10 ms (target < 2 ms)", () => {
    const rows: string[] = [];
    for (const [name, render] of cases) {
      for (let i = 0; i < 50; i++) render(); // warm up the JIT
      const start = performance.now();
      let bytes = 0;
      for (let i = 0; i < RUNS; i++) bytes = render().length;
      const ms = (performance.now() - start) / RUNS;
      rows.push(
        `${name.padEnd(28)} ${ms.toFixed(3).padStart(7)} ms  ${String(bytes).padStart(6)} B`,
      );
      expect(ms, name).toBeLessThan(10);
    }
    console.log(`\nms/render (${RUNS} runs)\n${rows.join("\n")}`);
  });
});
