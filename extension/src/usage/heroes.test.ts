import { describe, expect, it } from "vitest";
import {
  capacityMetrics,
  capacityPanel,
  quotaPanel,
  spendHeroes,
  usageMetrics,
} from "./heroes";
import { summarize } from "./summary";
import { QuotaLimits, WEEK_SECONDS } from "./limits";
import { AccountQuota, SpendAggregate } from "./types";

const decode = (uri: string) =>
  Buffer.from(uri.split(";base64,")[1].split("?")[0], "base64").toString();

const NOW = Date.UTC(2026, 9, 9, 12, 0);
const RESET = NOW / 1000 + 0.68 * WEEK_SECONDS; // 32 % of the week gone

function limits(weekly: number, models: QuotaLimits["models"] = []) {
  return {
    weekly: { label: "Weekly", percent: weekly, resetsAt: RESET },
    session: { label: "5h session", percent: 12, resetsAt: NOW / 1000 + 3600 },
    models,
  };
}

function spend(totals: number[]): SpendAggregate {
  return {
    today: {},
    todayTotal: totals[totals.length - 1] ?? 0,
    sevenDayTotal: totals.slice(-7).reduce((a, b) => a + b, 0),
    dailyTotals: totals.map((total, i) => ({
      bucket: new Date(NOW - (totals.length - 1 - i) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      total,
    })),
  };
}

describe("quotaPanel", () => {
  it("leads with the weekly, then the 5h session, then the API's model cap", () => {
    const svg = decode(
      quotaPanel(
        limits(14, [
          { label: "Fable", percent: 3, resetsAt: RESET, shareOfWeekly: 50 },
        ]),
        NOW,
      ),
    );
    const order = ["WEEKLY", "5H SESSION", "FABLE WEEKLY"].map((label) =>
      svg.indexOf(label),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(svg.indexOf(">14<")).toBeLessThan(svg.indexOf(">12<"));
    expect(svg).toContain("cap = 50% of weekly");
    expect(svg).not.toMatch(/sonnet/i);
  });

  it("colours the weekly by pace, not by the raw percent", () => {
    // 40 % at 32 % of the week: well under 50 %, but ahead of pace
    expect(decode(quotaPanel(limits(40), NOW))).toContain("raycast-red");
    expect(decode(quotaPanel(limits(14), NOW))).not.toContain("raycast-red");
  });
});

describe("usageMetrics", () => {
  it("projects the weekly at reset and shows this quota week's spend", () => {
    const svg = decode(
      usageMetrics({
        limits: limits(14),
        spend: spend(Array.from({ length: 30 }, () => 2)),
        nowMs: NOW,
      }),
    );
    expect(svg).toContain(">AT RESET<");
    expect(svg).toContain("~44%");
    expect(svg).toContain(">WEEK GONE<");
    expect(svg).toContain(">32%<");
    expect(svg).toContain(">THIS WEEK<");
    // the week started 2.24 days ago → 3 UTC day buckets
    expect(svg).toContain(">$6.00<");
  });

  it("says when the weekly runs out while ahead of pace", () => {
    const svg = decode(
      usageMetrics({ limits: limits(40), spend: null, nowMs: NOW }),
    );
    expect(svg).toContain(">RUNS OUT<");
    expect(svg).not.toContain("TODAY");
  });

  it("compares today against the average complete day", () => {
    const svg = decode(
      usageMetrics({
        limits: limits(14),
        spend: spend([2, 2, 2, 2, 2, 2, 6]),
        nowMs: NOW,
      }),
    );
    expect(svg).toContain(">$6.00<");
    expect(svg).toContain("▲ $4.00 vs avg");
  });

  it("copes with no history at all", () => {
    const svg = decode(
      usageMetrics({ limits: limits(14), spend: spend([]), nowMs: NOW }),
    );
    expect(svg).not.toMatch(/NaN|undefined/);
    expect(svg).toContain(">$0.00<");
  });
});

describe("spendHeroes", () => {
  it("draws one bar per day, the days before the quota week quieter", () => {
    const { days } = spendHeroes(
      spend(Array.from({ length: 30 }, (_, i) => i + 1)),
      RESET - WEEK_SECONDS,
    );
    const svg = decode(days);
    expect(svg).not.toMatch(/NaN|undefined/);
    expect(svg).toContain("avg $");
  });
});

describe("capacityPanel", () => {
  const account = (over: Partial<AccountQuota>): AccountQuota => ({
    id: "iu",
    plan: "max20x",
    fiveHourPct: 4,
    sevenDayPct: 14,
    fiveHourResetsAt: NOW / 1000 + 3600,
    sevenDayResetsAt: RESET,
    authOk: true,
    exhaustedUntil: null,
    updatedAt: NOW / 1000,
    ...over,
  });
  const summary = (accounts: AccountQuota[]) =>
    summarize(accounts, undefined, NOW / 1000);

  it("draws the pool first, then one column per account", () => {
    const svg = decode(
      capacityPanel(
        summary([
          account({ sevenDayPct: 89 }),
          account({ id: "me", plan: "max5x", sevenDayPct: 9 }),
        ]),
      ),
    );
    expect(svg.indexOf("POOL")).toBeLessThan(svg.indexOf("IU"));
    expect(svg.indexOf("IU")).toBeLessThan(svg.indexOf("ME"));
    expect(svg).toContain(">73<"); // (20·89 + 5·9) / 25
    expect(svg).toContain("6.8x of 25x left");
    expect(svg).toContain("MAX5X · WORKING");
  });

  it("says why an account the picker would skip is skipped, and greys it", () => {
    const svg = decode(
      capacityPanel(
        summary([
          account({ authOk: false, sevenDayPct: 8 }),
          account({ id: "me", plan: "max5x" }),
        ]),
      ),
    );
    expect(svg).toContain("login expired");
    expect(svg).toContain("raycast-secondary-text");
  });

  it("shows each account's 5h window next to spend", () => {
    const svg = decode(
      capacityMetrics({
        summary: summary([account({}), account({ id: "me", plan: "max5x" })]),
        spend: spend([1, 2, 3]),
        nowMs: NOW,
      }),
    );
    expect(svg).toContain(">IU 5H<");
    expect(svg).toContain(">TODAY<");
    expect(svg).not.toMatch(/NaN|undefined/);
  });
});
