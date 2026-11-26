import { describe, expect, it } from "vitest";
import {
  checkContinuable,
  LastScan,
  MORE_MAX_AGE_MS,
  moreResult,
  parseLastScan,
  planMore,
} from "./continue";

const NOW = 1_000_000_000;
const last = (patch: Partial<LastScan> = {}): LastScan => ({
  mode: "feeder",
  fileName: "scan-2026-11-26-183455.pdf",
  path: "/inbox/scan-2026-11-26-183455.pdf",
  pages: 12,
  at: NOW - 60_000,
  ...patch,
});

describe("parseLastScan", () => {
  it("reads a last-scan.json", () => {
    expect(parseLastScan({ ...last(), frontsPages: 29 })).toEqual({
      ...last(),
      frontsPages: 29,
    });
    expect(parseLastScan(last())?.frontsPages).toBeUndefined();
  });

  it("rejects anything else, and mode more", () => {
    for (const bad of [
      null,
      "x",
      {},
      { ...last(), mode: "more" },
      { ...last(), mode: "nope" },
      { ...last(), pages: 0 },
      { ...last(), pages: "12" },
      { ...last(), path: undefined },
      { ...last(), at: "now" },
    ]) {
      expect(parseLastScan(bad)).toBeNull();
    }
  });
});

describe("checkContinuable", () => {
  it("accepts a young scan whose kept pages are all there", () => {
    expect(checkContinuable(last(), 12, NOW)).toEqual({
      ok: true,
      last: last(),
    });
  });

  it("has nothing to continue without a scan or with other kept pages", () => {
    expect(checkContinuable(null, 0, NOW)).toEqual({
      ok: false,
      message: "Nothing to continue",
    });
    expect(checkContinuable(last(), 11, NOW)).toEqual({
      ok: false,
      message: "Nothing to continue",
    });
    expect(checkContinuable(last(), 13, NOW).ok).toBe(false);
  });

  it("says when the last scan is older than 30 minutes", () => {
    const old = last({ at: NOW - MORE_MAX_AGE_MS });
    expect(checkContinuable(old, 12, NOW)).toEqual({
      ok: false,
      message: "Nothing to continue (the last scan is older than 30 minutes)",
    });
    expect(
      checkContinuable(last({ at: NOW - MORE_MAX_AGE_MS + 1 }), 12, NOW).ok,
    ).toBe(true);
  });
});

describe("planMore", () => {
  it("appends only while the file is there and the consumer lock is not", () => {
    expect(planMore({ fileExists: true, lockExists: false })).toEqual({
      kind: "append",
    });
    expect(planMore({ fileExists: false, lockExists: false })).toEqual({
      kind: "separate",
      reason: "picked-up",
    });
    expect(planMore({ fileExists: true, lockExists: true })).toEqual({
      kind: "separate",
      reason: "locked",
    });
    expect(planMore({ fileExists: false, lockExists: true })).toEqual({
      kind: "separate",
      reason: "locked",
    });
  });
});

describe("moreResult", () => {
  const base = {
    newPages: 17,
    deliveredPath: "/inbox/scan-2026-11-26-183455.pdf",
    deliveredName: "scan-2026-11-26-183455.pdf",
    nowMs: NOW,
  };

  it("appended: totals, same file, pages appended, same mode", () => {
    const r = moreResult({
      ...base,
      plan: { kind: "append" },
      last: last({ pages: 12, mode: "fronts" }),
    });
    expect(r.message).toBe(
      "17 more pages, 29 in total -> scan-2026-11-26-183455.pdf",
    );
    expect(r.keepPages).toBe("append");
    expect(r.lastScan).toEqual({
      mode: "fronts",
      fileName: base.deliveredName,
      path: base.deliveredPath,
      pages: 29,
      at: NOW,
      frontsPages: undefined,
    });
    expect(r.frontsPages).toBe(29); // a continued fronts scan updates its pairing
  });

  it("singular page", () => {
    expect(
      moreResult({
        ...base,
        newPages: 1,
        plan: { kind: "append" },
        last: last(),
      }).message,
    ).toMatch(/^1 more page, 13 in total/);
  });

  it("re-checks a backs scan against the known fronts count", () => {
    const backs = last({ mode: "backs", frontsPages: 29, pages: 12 });
    expect(
      moreResult({ ...base, plan: { kind: "append" }, last: backs }).message,
    ).toBe("17 more pages, 29 in total -> scan-2026-11-26-183455.pdf");
    expect(
      moreResult({
        ...base,
        newPages: 5,
        plan: { kind: "append" },
        last: backs,
      }).message,
    ).toBe(
      "5 more pages, 17 in total -> scan-2026-11-26-183455.pdf (fronts had 29)",
    );
    expect(
      moreResult({ ...base, plan: { kind: "append" }, last: backs }).lastScan
        .frontsPages,
    ).toBe(29);
    // without a known fronts count there is nothing to compare
    expect(
      moreResult({
        ...base,
        plan: { kind: "append" },
        last: last({ mode: "backs" }),
      }).message,
    ).not.toContain("fronts had");
  });

  it("separate: the new pages on their own, as a plain feeder scan", () => {
    const r = moreResult({
      ...base,
      deliveredName: "scan-2026-11-26-185000.pdf",
      deliveredPath: "/inbox/scan-2026-11-26-185000.pdf",
      plan: { kind: "separate", reason: "picked-up" },
      last: last({ mode: "backs", frontsPages: 29 }),
    });
    expect(r.message).toBe(
      "17 pages -> scan-2026-11-26-185000.pdf (the first part was already picked up)",
    );
    expect(r.keepPages).toBe("replace");
    expect(r.lastScan).toEqual({
      mode: "feeder",
      fileName: "scan-2026-11-26-185000.pdf",
      path: "/inbox/scan-2026-11-26-185000.pdf",
      pages: 17,
      at: NOW,
    });
    expect(r.frontsPages).toBeUndefined();
  });

  it("separate because the lock is there reads the same; an unremovable file says so", () => {
    const common = { ...base, last: last() };
    expect(
      moreResult({ ...common, plan: { kind: "separate", reason: "locked" } })
        .message,
    ).toContain("(the first part was already picked up)");
    expect(
      moreResult({
        ...common,
        plan: { kind: "separate", reason: "not-replaceable" },
      }).message,
    ).toContain("(the first part could not be replaced)");
  });
});
