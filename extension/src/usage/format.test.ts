import { describe, it, expect } from "vitest";
import {
  formatUtilization,
  formatRelativeReset,
  formatSpend,
  menuBarTitle,
} from "./format";
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

  it("renders days at 24h+", () => {
    const epoch = Date.now() / 1000 + 2 * 24 * 60 * 60;
    expect(formatRelativeReset(epoch)).toBe("2d");
  });
});

describe("formatSpend", () => {
  it("renders two decimal dollars", () => {
    expect(formatSpend(1.5)).toBe("$1.50");
    expect(formatSpend(0)).toBe("$0.00");
    expect(formatSpend(12.345)).toBe("$12.35");
  });
});

describe("menuBarTitle", () => {
  it("renders the 5h/7d summary on a healthy quota", () => {
    const quota: UsageQuota = {
      five_hour: { utilization: 12, resets_at_epoch: 1 },
      seven_day: { utilization: 38, resets_at_epoch: 2 },
      seven_day_sonnet: { utilization: 5, resets_at_epoch: 3 },
      fetched_at: Date.now() / 1000,
    };
    expect(menuBarTitle(quota)).toBe("5h 12% · 7d 38%");
  });

  it("renders an error title on the error shape", () => {
    const quota: UsageQuota = { error: "no login", fetched_at: 0 };
    expect(menuBarTitle(quota)).toBe("Claude: error");
  });
});
