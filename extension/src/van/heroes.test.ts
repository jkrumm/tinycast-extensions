import { describe, expect, it } from "vitest";
import {
  chargePoints,
  chargeChartImage,
  panelColumns,
  statusPanelImage,
  yieldChartImage,
  yieldTotalText,
} from "./heroes";
import {
  HELPER_BATTERY_BUSY,
  HELPER_FULL,
  HELPER_NO_KEY,
  fixtureSamples,
  fixtureVictronAll,
  fixtureVictronHistory,
} from "./fixtures";
import { toReading } from "./parse";
import { Location } from "./sun";
import { compactTrends } from "./history";
import { Sample, VanReading, VanView } from "./types";

const now = new Date(2026, 9, 5, 14, 30).getTime();

const view = (reading: VanReading, samples: Sample[] = []): VanView => ({
  reading,
  samples,
});
const read = (helper = HELPER_FULL, keyMissing = false) =>
  toReading({ helper, keyMissing, now });
const decode = (uri: string) =>
  Buffer.from(uri.split(";base64,")[1].split("?")[0], "base64").toString();

describe("status panel", () => {
  it("battery: charge, gauge colour, and current · direction · voltage on one line", () => {
    const [battery] = panelColumns(view(read()));
    expect(battery).toMatchObject({
      label: "Battery",
      unit: "%",
      gauge: "battery",
      sub: "−12.8 A · empty in ~15h · 13.71 V",
    });
    expect(battery.value).toBe(read().battery!.soc);
  });

  it("solar: watts, bar, and charge state · yield today", () => {
    const columns = panelColumns(view(read()));
    expect(columns[1]).toMatchObject({
      label: "Solar",
      value: 19,
      unit: "W",
      sub: "Absorption · 30 Wh today",
    });
  });

  it("idle and charging read as such", () => {
    const reading = read();
    const withAmps = (currentA: number) =>
      panelColumns(
        view({ ...reading, battery: { ...reading.battery!, currentA } }),
      )[0].sub;
    expect(withAmps(0.1)).toMatch(/^\+0\.1 A · idle · /);
    expect(withAmps(8.4)).toMatch(/^\+8\.4 A · full in /);
  });

  it("omits a side that could not be read", () => {
    expect(
      panelColumns(view(read(HELPER_BATTERY_BUSY))).map((c) => c.label),
    ).toEqual(["Solar"]);
    expect(
      panelColumns(view(read(HELPER_NO_KEY, true))).map((c) => c.label),
    ).toEqual(["Battery"]);
    const none = view({ ...read(), battery: null, solar: null });
    expect(panelColumns(none)).toEqual([]);
    expect(statusPanelImage(none)).toBeNull();
  });
});

const berlin: Location = { lat: 52.52, lon: 13.405 };
const HOUR = 3_600_000;

function socSample(t: number, soc: number | null): Sample {
  return { ...fixtureSamples(t, 1)[0], t, soc };
}

describe("3-day charge chart", () => {
  it("breaks the line where readings are more than 3 h apart, and counts only real readings", () => {
    const samples = [
      socSample(now - 60 * HOUR, 80),
      socSample(now - 59 * HOUR, 79),
      socSample(now - 30 * HOUR, 60), // 29 h gap
      socSample(now - 29 * HOUR, 62),
      socSample(now - 28 * HOUR + 10 * 60_000, 63),
    ];
    const { times, values, readings } = chargePoints(samples, now);
    expect(readings).toBe(5);
    expect(values).toEqual([80, 79, null, 60, 62, 63]);
    // the break marker sits in the middle of the gap, ascending
    expect(times[2]).toBe(now - 59 * HOUR + (29 * HOUR) / 2);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("ignores readings without a charge and anything older than 72 h", () => {
    const samples = [
      socSample(now - 80 * HOUR, 50),
      socSample(now - 10 * HOUR, null),
      socSample(now - 5 * HOUR, 70),
    ];
    expect(chargePoints(samples, now).readings).toBe(1);
  });

  const trends = compactTrends(fixtureVictronAll(now).trends);
  const chart = (samples: Sample[], t = trends) =>
    chargeChartImage({ samples, trends: t, now, location: berlin });
  it("nothing to draw without a trend and under 6 readings; the charge line alone from 6", () => {
    expect(chart(fixtureSamples(now, 4), null)).toBeNull();
    expect(chart([], null)).toBeNull();
    const own = decode(chart(fixtureSamples(now, 12), null)!);
    expect(own).toContain(">Battery charge<");
    expect(own).toContain("20% low");
  });

  it("two stacked charts: the estimated battery % on top (green area, 20 % low, chips), solar W below, readings as bare dots", () => {
    const samples = [0, 1, 2, 22, 40, 41, 66, 67, 68].map((h) =>
      socSample(now - (70 - h) * HOUR, 70 + (h % 9)),
    );
    const svg = decode(chart(samples)!);
    // a 200 pt battery chart over a 150 pt solar chart, one 350 pt image
    expect(svg).toMatch(/^<svg [^>]*height="350"/);
    expect(
      svg.indexOf(">Battery · estimated from charge/discharge, ● measured<"),
    ).toBeGreaterThan(0);
    expect(svg.indexOf(">Battery ·")).toBeLessThan(svg.indexOf(">Solar<")); // battery on top
    expect(svg).toContain("20% low");
    expect(svg).toContain(">100%<"); // the 0–100 % axis
    expect(svg).toContain("raycast-yellow");
    expect(svg).not.toContain("Battery V"); // the voltage chart is gone
    expect(svg).not.toMatch(/>\d\d %</); // no per-dot text labels
    expect(svg).toMatch(/<linearGradient id="f-green/); // the gradient fill
    // the night is shaded in both charts, weekday labels only once (the bottom)
    expect(svg.match(/fill-opacity="0.1"/g)!.length).toBeGreaterThanOrEqual(6);
    for (const day of ["Sat", "Sun", "Mon"]) {
      expect(svg.match(new RegExp(`>${day}<`, "g"))).toHaveLength(1);
    }
    // each measured reading is a solid dot: 9 readings (+ chips) ≥ 9 dots of r=3.5
    expect(
      svg.match(/r="3.5" fill="raycast-green"/g)!.length,
    ).toBeGreaterThanOrEqual(9);
  });

  it("the stacked charts share a plot area (same left axis width)", () => {
    const svg = decode(chart(fixtureSamples(now, 12))!);
    const gridStarts = new Set(
      [
        ...svg.matchAll(
          /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="\2"/g,
        ),
      ].map((m) => m[1]),
    );
    expect(gridStarts.size).toBeLessThanOrEqual(2); // plot edge (+ the baseline's +0.5)
  });

  it("battery alone (no solar trend) and solar alone (no readings) each still draw", () => {
    const noSolar = {
      ...trends!,
      trends: trends!.trends.filter((t) => t.vreg !== 0xec8a),
    };
    const battery = decode(chart(fixtureSamples(now, 12), noSolar)!);
    expect(battery).toContain(">Battery ·");
    expect(battery).not.toContain(">Solar<");
    expect(battery).toMatch(/>Mon</); // its own x labels when it is the only chart
    // the estimate stands on the voltage trend even with no readings at all
    expect(decode(chart([])!)).toContain(">Battery ·");
    const onlySolar = {
      ...trends!,
      trends: trends!.trends.filter((t) => t.vreg === 0xec8a),
    };
    const solar = decode(chart([], onlySolar)!);
    expect(solar).toContain(">Solar<");
    expect(solar).not.toContain("Battery");
    expect(solar).toMatch(/height="190"/);
  });

  it("with no trend it falls back to the measured line from 6 readings", () => {
    const svg = decode(chart(fixtureSamples(now, 12), null)!);
    expect(svg).toContain(">Battery charge<");
    expect(svg).not.toContain("estimated");
  });
});

describe("Victron history section", () => {
  const history = fixtureVictronHistory(now, 30);

  it("yield: 14 bars, only the best day labelled, a subtle dashed average", () => {
    const svg = decode(yieldChartImage(history)!);
    expect(svg).toContain("raycast-yellow");
    expect(svg).toContain("avg ");
    expect(svg).toContain("stroke-dasharray");
    expect(svg.match(/<path d="M[^"]*" fill="url/g)).toHaveLength(14);
    const best = Math.max(...history.days.slice(0, 14).map((d) => d.yieldWh));
    expect(svg).toContain(`>${(best / 1000).toFixed(2)} kWh<`);
    // weekday over day number on the axis, today (the 5th) last and bold
    expect(svg).toContain(">Mon<");
    expect(svg).toContain(">5<");
  });

  it("yield: the average counts complete days only", () => {
    const sunny = fixtureVictronHistory(now, 5);
    sunny.days.forEach((d) => (d.yieldWh = 1000));
    sunny.days[0].yieldWh = 0; // today, barely started
    expect(decode(yieldChartImage(sunny)!)).toContain("avg 1.00 kWh");
  });

  it("yield: nothing without at least two days", () => {
    expect(yieldChartImage(null)).toBeNull();
    expect(
      yieldChartImage({ ...history, days: history.days.slice(0, 1) }),
    ).toBeNull();
  });

  it("yield total: kWh over what the device remembers", () => {
    const total = history.days.reduce((sum, d) => sum + d.yieldWh, 0);
    expect(yieldTotalText(history)).toBe(
      `${(total / 1000).toFixed(1)} kWh in 30 days`,
    );
    expect(yieldTotalText(fixtureVictronHistory(now, 9))).toMatch(/in 9 days$/);
    expect(yieldTotalText(null)).toBeNull();
  });
});
