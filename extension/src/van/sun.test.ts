import { describe, expect, it } from "vitest";
import { defaultLocation, nightSpans, sunTimes } from "./sun";

const MIN = 60_000;
const HOUR = 60 * MIN;
const utc = (y: number, m: number, d: number, h = 0, min = 0) =>
  Date.UTC(y, m - 1, d, h, min);

// Reference times from timeanddate.com / NOAA's own calculator (UTC), ±3 min.
function expectNear(actual: number, expected: number, minutes = 3) {
  expect(Math.abs(actual - expected) / MIN).toBeLessThanOrEqual(minutes);
}

describe("sunTimes", () => {
  it("Berlin, summer solstice 2026: ≈ 02:43 → 19:33 UTC", () => {
    const sun = sunTimes({
      year: 2026,
      month: 6,
      day: 21,
      location: { lat: 52.52, lon: 13.405 },
    });
    if (sun.kind !== "day-night") throw new Error("expected a normal day");
    expectNear(sun.sunrise, utc(2026, 6, 21, 2, 43));
    expectNear(sun.sunset, utc(2026, 6, 21, 19, 33));
  });

  it("Berlin, winter solstice 2026: ≈ 07:16 → 14:54 UTC", () => {
    const sun = sunTimes({
      year: 2026,
      month: 12,
      day: 21,
      location: { lat: 52.52, lon: 13.405 },
    });
    if (sun.kind !== "day-night") throw new Error("expected a normal day");
    expectNear(sun.sunrise, utc(2026, 12, 21, 7, 16));
    expectNear(sun.sunset, utc(2026, 12, 21, 14, 54));
  });

  it("New York, summer solstice 2026: sunrise ≈ 09:25 UTC (5:25 EDT)", () => {
    const sun = sunTimes({
      year: 2026,
      month: 6,
      day: 21,
      location: { lat: 40.7128, lon: -74.006 },
    });
    if (sun.kind !== "day-night") throw new Error("expected a normal day");
    expectNear(sun.sunrise, utc(2026, 6, 21, 9, 25));
  });

  it("sunset in the Americas lands on the next UTC day (still ordered after sunrise)", () => {
    const sun = sunTimes({
      year: 2026,
      month: 6,
      day: 21,
      location: { lat: 40.7128, lon: -74.006 },
    });
    if (sun.kind !== "day-night") throw new Error("expected a normal day");
    expect(sun.sunset).toBeGreaterThan(utc(2026, 6, 22));
    expect(sun.sunset).toBeGreaterThan(sun.sunrise);
    expectNear(sun.sunset, utc(2026, 6, 22, 0, 31), 4);
  });

  it("the sun can stay up or down all day near the pole", () => {
    const tromso = { lat: 69.65, lon: 18.96 };
    expect(
      sunTimes({ year: 2026, month: 6, day: 21, location: tromso }).kind,
    ).toBe("polar-day");
    expect(
      sunTimes({ year: 2026, month: 12, day: 21, location: tromso }).kind,
    ).toBe("polar-night");
  });
});

describe("nightSpans", () => {
  const berlin = { lat: 52.52, lon: 13.405 };

  it("one night per dusk between two days, clipped to the window", () => {
    const from = utc(2026, 10, 2, 12);
    const to = utc(2026, 10, 5, 12);
    const spans = nightSpans({ from, to, location: berlin });
    // 3 days noon→noon: nights of the 2nd, 3rd and 4th
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      expect(span.from).toBeGreaterThanOrEqual(from);
      expect(span.to).toBeLessThanOrEqual(to);
      const hours = (span.to - span.from) / HOUR;
      expect(hours).toBeGreaterThan(10);
      expect(hours).toBeLessThan(13); // early October, 52° N
    }
    // spans are ordered and disjoint
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].from).toBeGreaterThan(spans[i - 1].to);
    }
  });

  it("a window that starts in the dark begins with a clipped night", () => {
    const from = utc(2026, 10, 3, 1); // 03:00 local, dark
    const spans = nightSpans({ from, to: from + 6 * HOUR, location: berlin });
    expect(spans[0].from).toBe(from);
    expect(spans[0].to).toBeLessThan(from + 6 * HOUR); // sunrise inside it
  });

  it("polar day has no night, polar night is all night", () => {
    const tromso = { lat: 69.65, lon: 18.96 };
    const summer = utc(2026, 6, 21);
    expect(
      nightSpans({
        from: summer,
        to: summer + 2 * 86_400_000,
        location: tromso,
      }),
    ).toEqual([]);
    const winter = utc(2026, 12, 21);
    expect(
      nightSpans({ from: winter, to: winter + 86_400_000, location: tromso }),
    ).toEqual([{ from: winter, to: winter + 86_400_000 }]);
  });
});

describe("defaultLocation", () => {
  it("is 45° N with the longitude of the machine's UTC offset (15° per hour)", () => {
    const fallback = defaultLocation(utc(2026, 10, 5));
    expect(fallback.lat).toBe(45);
    expect(fallback.lon % 15).toBeCloseTo(0, 6); // a whole number of hours
    expect(Math.abs(fallback.lon)).toBeLessThanOrEqual(180);
  });

  it("puts the night where a timezone-only guess should: dark at local midnight, light at noon", () => {
    const now = new Date(2026, 9, 5, 14, 0).getTime();
    const location = defaultLocation(now);
    const midnight = new Date(2026, 9, 4, 0, 0).getTime();
    const noon = new Date(2026, 9, 4, 12, 0).getTime();
    const spans = nightSpans({
      from: midnight - 86_400_000,
      to: now,
      location,
    });
    const dark = (t: number) => spans.some((s) => t >= s.from && t < s.to);
    expect(dark(midnight + 60_000)).toBe(true);
    expect(dark(noon)).toBe(false);
  });
});
