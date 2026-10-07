import { describe, it, expect } from "vitest";
import { formatAge, freshnessBanner, updatingLine } from "./freshness";

const NOW = 1_800_000_000_000;

describe("formatAge", () => {
  it("scales from just now to days", () => {
    expect(formatAge(NOW - 10_000, NOW)).toBe("just now");
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(formatAge(NOW - 2 * 86_400_000, NOW)).toBe("2 d ago");
  });
});

describe("freshnessBanner", () => {
  it("is null while data is live", () => {
    expect(freshnessBanner({ fetchedAt: NOW, error: undefined })).toBeNull();
  });

  it("warns when the refresh failed over cached data", () => {
    expect(
      freshnessBanner({
        fetchedAt: NOW - 2 * 3_600_000,
        error: new Error("curl exited 7"),
        offlineLabel: "Router not reachable",
        now: NOW,
      }),
    ).toBe(
      "> ⚠️ **Router not reachable** — showing the last known state from 2 h ago.",
    );
  });

  it("is null without cached data (the view shows the error itself)", () => {
    expect(
      freshnessBanner({ fetchedAt: undefined, error: new Error("x") }),
    ).toBeNull();
  });
});

describe("updatingLine", () => {
  it("only shows while loading over cached data", () => {
    expect(updatingLine({ fetchedAt: NOW, isLoading: false })).toBeNull();
    expect(updatingLine({ fetchedAt: undefined, isLoading: true })).toBeNull();
    expect(
      updatingLine({ fetchedAt: NOW - 120_000, isLoading: true, now: NOW }),
    ).toBe("_Updating… (shown: 2 min ago)_");
  });
});
