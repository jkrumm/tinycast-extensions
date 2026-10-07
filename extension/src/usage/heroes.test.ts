import { describe, expect, it } from "vitest";
import { totalsCards } from "./heroes";
import { SpendAggregate } from "./types";

const decode = (uri: string) =>
  Buffer.from(uri.split(";base64,")[1].split("?")[0], "base64").toString();

function spend(totals: number[]): SpendAggregate {
  return {
    today: {},
    todayTotal: totals[totals.length - 1] ?? 0,
    sevenDayTotal: totals.reduce((a, b) => a + b, 0),
    dailyTotals: totals.map((total, i) => ({
      bucket: `2026-10-0${i + 1}`,
      total,
    })),
  };
}

describe("totalsCards", () => {
  it("shows today against the daily average, and the 7-day total", () => {
    const svg = decode(totalsCards(spend([2, 2, 2, 2, 2, 2, 6])));
    expect(svg).toContain(">TODAY<");
    expect(svg).toContain(">$6.00<");
    expect(svg).toContain("▲ $3.43 vs avg"); // average 2.571…
    expect(svg).toContain(">$18.00<");
    expect(svg).not.toContain('stroke-width="1.75"'); // the day bars are the trend
  });

  it("spending under the average is the good direction", () => {
    const svg = decode(totalsCards(spend([6, 6, 6, 6, 6, 6, 2])));
    expect(svg).toContain("▼");
    expect(svg).toContain("raycast-green");
  });

  it("omits the delta with fewer than three days of history", () => {
    const svg = decode(totalsCards(spend([4, 5])));
    expect(svg).not.toContain("vs avg");
    expect(svg).toContain(">$5.00<");
  });

  it("copes with no history at all", () => {
    const svg = decode(totalsCards(spend([])));
    expect(svg).not.toMatch(/NaN|undefined/);
    expect(svg).toContain(">$0.00<");
  });
});
