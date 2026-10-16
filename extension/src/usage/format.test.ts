import { describe, it, expect } from "vitest";
import {
  extraUsageLine,
  formatPace,
  formatUtilization,
  formatRelativeReset,
  formatSpend,
  formatWeekdayTime,
  menuBarTitle,
  menuBarTitleWithFreshness,
  overflowModelsLine,
  spendErrorText,
  usageTileStatus,
} from "./format";
import { quotaLimits } from "./limits";
import { UsageQuota } from "./types";

describe("formatUtilization", () => {
  it("renders a percentage rounded to the nearest integer", () => {
    expect(formatUtilization({ utilization: 12.4, resets_at_epoch: 0 })).toBe(
      "12%",
    );
    expect(formatUtilization({ utilization: 12.6, resets_at_epoch: 0 })).toBe(
      "13%",
    );
  });

  it("renders an em dash for null utilization", () => {
    expect(
      formatUtilization({ utilization: null, resets_at_epoch: null }),
    ).toBe("—");
  });
});

describe("formatRelativeReset", () => {
  it("renders an em dash for null", () => {
    expect(formatRelativeReset(null)).toBe("—");
  });

  it("renders 'now' once the reset has passed", () => {
    expect(formatRelativeReset(Date.now() / 1000 - 10)).toBe("now");
  });

  it("renders minutes under an hour", () => {
    const epoch = Date.now() / 1000 + 30 * 60;
    expect(formatRelativeReset(epoch)).toBe("30m");
  });

  it("renders hours and minutes under a day", () => {
    const epoch = Date.now() / 1000 + (3 * 60 + 15) * 60;
    expect(formatRelativeReset(epoch)).toBe("3h 15m");
  });

  it("renders whole hours without minutes", () => {
    const epoch = Date.now() / 1000 + 4 * 60 * 60;
    expect(formatRelativeReset(epoch)).toBe("4h");
  });

  it("renders whole days at 24h+", () => {
    const epoch = Date.now() / 1000 + 2 * 24 * 60 * 60;
    expect(formatRelativeReset(epoch)).toBe("2d");
  });

  it("renders days and hours for the weekly reset", () => {
    const now = 1_000_000_000_000;
    const epoch = now / 1000 + (5 * 24 + 2) * 3600 + 600;
    expect(formatRelativeReset(epoch, now)).toBe("5d 2h");
  });
});

describe("formatSpend", () => {
  it("renders two decimal dollars", () => {
    expect(formatSpend(1.5)).toBe("$1.50");
    expect(formatSpend(0)).toBe("$0.00");
    expect(formatSpend(12.345)).toBe("$12.35");
  });
});

// /tmp/claude_sl/usage_api.json at 14:51 on 2026-10-09: the menu bar said
// "12%" — the 5h session, unlabelled — while the weekly was 14 %.
const BUG_REPORT_FILE: UsageQuota = {
  five_hour: { utilization: 12.0, resets_at_epoch: 1791554399 },
  seven_day: { utilization: 14.0, resets_at_epoch: 1791993599 },
  seven_day_sonnet: { utilization: null, resets_at_epoch: null },
  fetched_at: 1791553760,
};

describe("menuBarTitle", () => {
  it("shows the bare weekly percent, never the 5h number", () => {
    expect(menuBarTitle(BUG_REPORT_FILE)).toBe("14%");
  });

  it("appends the 5h session only once it is about to bite", () => {
    const quota: UsageQuota = {
      ...BUG_REPORT_FILE,
      five_hour: { utilization: 85, resets_at_epoch: 1 },
    } as UsageQuota;
    expect(menuBarTitle(quota)).toBe("14% · 5h 85%");
  });

  it("renders an error title on the error shape", () => {
    const quota: UsageQuota = { error: "no login", fetched_at: 0 };
    expect(menuBarTitle(quota)).toBe("Claude: error");
  });
});

describe("usageTileStatus", () => {
  it("leads with the weekly", () => {
    if ("error" in BUG_REPORT_FILE) throw new Error("fixture");
    expect(usageTileStatus(quotaLimits(BUG_REPORT_FILE))).toBe(
      "7d 14% · 5h 12%",
    );
  });
});

describe("formatWeekdayTime", () => {
  it("renders the local weekday and time", () => {
    const local = new Date(2026, 9, 14, 18, 5).getTime() / 1000; // a Wednesday
    expect(formatWeekdayTime(local)).toBe("Wed 18:05");
  });
});

describe("formatPace", () => {
  it("names the projected percent while on track", () => {
    expect(
      formatPace({
        elapsed: 32,
        projected: 43.7,
        status: "on-track",
        runsOutAt: null,
      }),
    ).toBe("On track — ~44% at reset");
  });

  it("says when the week runs out while ahead", () => {
    const runsOutAt = new Date(2026, 9, 12, 14, 0).getTime() / 1000; // Monday
    expect(
      formatPace({ elapsed: 50, projected: 120, status: "ahead", runsOutAt }),
    ).toBe("Ahead of pace — out ~Mon 14:00");
  });

  it("does not project too early", () => {
    expect(
      formatPace({
        elapsed: 1,
        projected: null,
        status: "early",
        runsOutAt: null,
      }),
    ).toBe("Too early to project");
  });
});

describe("extraUsageLine", () => {
  const extra = {
    is_enabled: true,
    monthly_limit: 8500,
    used_credits: 1234,
    currency: "EUR",
    decimal_places: 2,
  };

  it("renders minor units as money while enabled", () => {
    expect(extraUsageLine(extra)).toBe(
      "Extra usage this month: 12.34 EUR of 85.00 EUR",
    );
  });

  it("is silent while disabled or missing", () => {
    expect(extraUsageLine({ ...extra, is_enabled: false })).toBeNull();
    expect(extraUsageLine(null)).toBeNull();
    expect(extraUsageLine(undefined)).toBeNull();
  });
});

describe("overflowModelsLine", () => {
  it("lists the caps the panel had no room for", () => {
    expect(
      overflowModelsLine([
        { label: "Opus", percent: 40.4, resetsAt: null },
        { label: "Sonnet", percent: null, resetsAt: null },
      ]),
    ).toBe("Opus weekly 40% · Sonnet weekly —");
    expect(overflowModelsLine([])).toBeNull();
  });
});

describe("menuBarTitleWithFreshness", () => {
  it("marks only a stale quota, nothing else", () => {
    expect(menuBarTitleWithFreshness(BUG_REPORT_FILE, false)).toBe("14%");
    expect(menuBarTitleWithFreshness(BUG_REPORT_FILE, true)).toBe(
      "14% (stale)",
    );
  });
});

describe("spendErrorText", () => {
  it("says why the argo spend fetch failed", () => {
    expect(spendErrorText(new Error("timed out after 25s"))).toBe(
      "Spend unavailable — argo timed out after 25s",
    );
    expect(spendErrorText(new Error("401: unauthorized"))).toBe(
      "Spend unavailable — argo rejected the token",
    );
    expect(spendErrorText(new TypeError("Could not resolve host"))).toBe(
      "Spend unavailable — argo not reachable",
    );
    expect(spendErrorText("boom")).toBe("Spend unavailable — boom");
  });
});
