import { describe, expect, it } from "vitest";
import { WEEK_SECONDS, quotaLimits, weeklyPace } from "./limits";
import { UsageQuotaOk } from "./types";

// /tmp/claude_sl/usage_api.json at 14:51 on 2026-10-09, before the fetcher
// passed `limits` through: weekly 14, 5h 12, the legacy Sonnet bucket null.
const LEGACY_FILE: UsageQuotaOk = {
  five_hour: { utilization: 12.0, resets_at_epoch: 1791554399 },
  seven_day: { utilization: 14.0, resets_at_epoch: 1791993599 },
  seven_day_sonnet: { utilization: null, resets_at_epoch: null },
  fetched_at: 1791553760,
};

const CURRENT_FILE: UsageQuotaOk = {
  ...LEGACY_FILE,
  limits: [
    {
      kind: "session",
      group: "session",
      label: null,
      percent: 13,
      resets_at_epoch: 1791554400,
      severity: "normal",
      is_active: false,
      allowance_percent_of_weekly: null,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      label: null,
      percent: 14,
      resets_at_epoch: 1791993600,
      severity: "normal",
      is_active: true,
      allowance_percent_of_weekly: null,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      label: "Fable",
      percent: 3,
      resets_at_epoch: 1791993600,
      severity: "normal",
      is_active: false,
      allowance_percent_of_weekly: 50,
    },
  ],
};

describe("quotaLimits", () => {
  it("never swaps the weekly and the 5h session (12 % shown, weekly 14 %)", () => {
    const { weekly, session } = quotaLimits(LEGACY_FILE);
    expect(weekly.percent).toBe(14);
    expect(weekly.resetsAt).toBe(1791993599);
    expect(session.percent).toBe(12);
  });

  it("shows no model cap for a null legacy Sonnet bucket", () => {
    expect(quotaLimits(LEGACY_FILE).models).toEqual([]);
  });

  it("takes model caps from the generic list, labelled by the API", () => {
    expect(quotaLimits(CURRENT_FILE).models).toEqual([
      {
        label: "Fable",
        percent: 3,
        resetsAt: 1791993600,
        shareOfWeekly: 50,
      },
    ]);
  });

  it("ignores the session/weekly_all entries of the list", () => {
    const { weekly, session, models } = quotaLimits(CURRENT_FILE);
    expect(models).toHaveLength(1);
    expect(weekly.percent).toBe(14);
    expect(session.percent).toBe(12);
  });

  it("falls back to a filled legacy Sonnet bucket for an old file", () => {
    const old: UsageQuotaOk = {
      ...LEGACY_FILE,
      seven_day_sonnet: { utilization: 20, resets_at_epoch: 5 },
    };
    expect(quotaLimits(old).models).toEqual([
      { label: "Sonnet", percent: 20, resetsAt: 5 },
    ]);
  });

  it("an empty generic list wins over the legacy bucket", () => {
    const file: UsageQuotaOk = {
      ...LEGACY_FILE,
      seven_day_sonnet: { utilization: 20, resets_at_epoch: 5 },
      limits: [],
    };
    expect(quotaLimits(file).models).toEqual([]);
  });

  it("labels an unnamed scoped cap generically", () => {
    const file: UsageQuotaOk = {
      ...CURRENT_FILE,
      limits: [{ ...CURRENT_FILE.limits![2], label: null }],
    };
    expect(quotaLimits(file).models[0].label).toBe("Scoped");
  });
});

describe("weeklyPace", () => {
  const reset = 1_000_000_000;
  const start = reset - WEEK_SECONDS;
  const at = (fraction: number) => start + fraction * WEEK_SECONDS;
  const week = (percent: number | null) => ({
    label: "Weekly",
    percent,
    resetsAt: reset,
  });

  it("is on track below 90 % projected", () => {
    const pace = weeklyPace(week(14), at(0.32))!;
    expect(pace.elapsed).toBeCloseTo(32);
    expect(pace.projected).toBeCloseTo(43.75);
    expect(pace.status).toBe("on-track");
    expect(pace.runsOutAt).toBeNull();
  });

  it("is tight from 90 % projected", () => {
    expect(weeklyPace(week(47), at(0.5))!.status).toBe("tight");
  });

  it("is ahead past 100 % and says when it runs out", () => {
    const pace = weeklyPace(week(60), at(0.5))!;
    expect(pace.status).toBe("ahead");
    expect(pace.projected).toBeCloseTo(120);
    // 60 % in half a week → 100 % after 5/6 of it
    expect(pace.runsOutAt).toBeCloseTo(at(5 / 6));
  });

  it("does not project in the first hours of the week", () => {
    const pace = weeklyPace(week(5), at(0.01))!;
    expect(pace.status).toBe("early");
    expect(pace.projected).toBeNull();
  });

  it("is null without a percent or a reset", () => {
    expect(weeklyPace(week(null), at(0.5))).toBeNull();
    expect(
      weeklyPace({ label: "Weekly", percent: 10, resetsAt: null }, at(0.5)),
    ).toBeNull();
  });

  it("clamps a clock past the reset to the full week", () => {
    const pace = weeklyPace(week(40), reset + 3600)!;
    expect(pace.elapsed).toBe(100);
    expect(pace.projected).toBeCloseTo(40);
  });
});
