import { describe, expect, it } from "vitest";
import {
  backsStem,
  discardedMessage,
  filedMessage,
  moreMessage,
  parsePending,
  Pending,
  PendingPart,
  scannedMessage,
  startDecision,
} from "./pending-rules";

const part = (patch: Partial<PendingPart> = {}): PendingPart => ({
  mode: "feeder",
  fileName: "scan-2026-11-26-183455.pdf",
  pages: 17,
  at: 1000,
  ...patch,
});
const single = (patch: Partial<PendingPart> = {}): Pending => ({
  parts: [part(patch)],
});
const fronts = part({
  mode: "fronts",
  fileName: "scan-2026-11-26-183455-vorne.pdf",
  pages: 29,
});
const backs = part({
  mode: "backs",
  fileName: "scan-2026-11-26-183455-hinten.pdf",
  pages: 28,
});
const pair: Pending = { parts: [fronts, backs] };

describe("parsePending", () => {
  it("reads one part or a fronts/backs pair", () => {
    expect(parsePending(single())).toEqual(single());
    expect(parsePending(pair)).toEqual(pair);
  });

  it("rejects anything else", () => {
    for (const bad of [
      null,
      "x",
      {},
      { parts: [] },
      { parts: [part(), part(), part()] },
      { parts: [part({ mode: "more" as never })] },
      { parts: [{ ...part(), fileName: "" }] },
      { parts: [{ ...part(), pages: 0 }] },
      { parts: [{ ...part(), at: "now" }] },
      { parts: [part(), part()] }, // two parts must be fronts then backs
      { parts: [backs, fronts] },
    ]) {
      expect(parsePending(bad)).toBeNull();
    }
  });

  it("does not know an expiry any more", () => {
    expect(Object.keys(parsePending(single())!.parts[0]).sort()).toEqual([
      "at",
      "fileName",
      "mode",
      "pages",
    ]);
  });
});

describe("startDecision", () => {
  it("lets a scan go when nothing is pending", () => {
    for (const mode of ["feeder", "fronts", "flatbed"] as const) {
      expect(startDecision(null, mode)).toEqual({ kind: "go" });
    }
  });

  it("files a pending scan first for a new feeder, fronts or flatbed scan", () => {
    for (const pending of [single(), single({ mode: "fronts" }), pair]) {
      for (const mode of ["feeder", "fronts", "flatbed"] as const) {
        expect(startDecision(pending, mode)).toEqual({ kind: "submit-first" });
      }
    }
  });

  it("keeps the pending fronts for the backs: they go together", () => {
    expect(startDecision({ parts: [fronts] }, "backs")).toEqual({ kind: "go" });
  });

  it("refuses backs without pending fronts", () => {
    const refused = { kind: "refuse", message: "Scan the fronts first" };
    expect(startDecision(null, "backs")).toEqual(refused);
    expect(startDecision(single(), "backs")).toEqual(refused);
    expect(startDecision(single({ mode: "flatbed" }), "backs")).toEqual(
      refused,
    );
  });

  it("refuses a second backs scan", () => {
    expect(startDecision(pair, "backs")).toEqual({
      kind: "refuse",
      message: "The backs are already scanned. Submit Scan files both",
    });
  });

  it("lets Scan More continue whatever is pending, and refuses without", () => {
    expect(startDecision(single(), "more")).toEqual({ kind: "append" });
    expect(startDecision(pair, "more")).toEqual({ kind: "append" });
    expect(startDecision(null, "more")).toEqual({
      kind: "refuse",
      message: "Nothing to continue (the last scan is already filed)",
    });
  });

  it("names the backs after the fronts", () => {
    expect(backsStem({ parts: [fronts] })).toBe("scan-2026-11-26-183455");
  });
});

describe("messages", () => {
  it("after a scan", () => {
    expect(
      scannedMessage({ mode: "feeder", pages: 17, pending: single() }),
    ).toBe("17 pages scanned. Scan More to append, Submit Scan to file it.");
    expect(
      scannedMessage({ mode: "flatbed", pages: 1, pending: single() }),
    ).toBe("1 page scanned. Scan More to append, Submit Scan to file it.");
  });

  it("fronts say to flip the stack", () => {
    expect(
      scannedMessage({
        mode: "fronts",
        pages: 17,
        pending: { parts: [fronts] },
      }),
    ).toBe("17 pages scanned (fronts). Flip the stack, then Scan Backs.");
  });

  it("backs say that both are filed together, with the fronts note on a mismatch", () => {
    expect(scannedMessage({ mode: "backs", pages: 28, pending: pair })).toBe(
      "28 pages scanned (backs, fronts had 29). Submit Scan to file both.",
    );
    const even: Pending = { parts: [fronts, { ...backs, pages: 29 }] };
    expect(scannedMessage({ mode: "backs", pages: 29, pending: even })).toBe(
      "29 pages scanned (backs). Submit Scan to file both.",
    );
  });

  it("after Scan More", () => {
    expect(moreMessage({ newPages: 2, total: 19, pending: single() })).toBe(
      "2 more pages, 19 in total.",
    );
    expect(moreMessage({ newPages: 1, total: 18, pending: single() })).toBe(
      "1 more page, 18 in total.",
    );
    // appended to the backs: the fronts note is recomputed against the new total
    expect(
      moreMessage({
        newPages: 2,
        total: 30,
        pending: { parts: [fronts, { ...backs, pages: 30 }] },
      }),
    ).toBe("2 more pages, 30 in total (fronts had 29).");
    expect(
      moreMessage({
        newPages: 1,
        total: 29,
        pending: { parts: [fronts, { ...backs, pages: 29 }] },
      }),
    ).toBe("1 more page, 29 in total.");
    // appended to the fronts: nothing to compare yet
    expect(
      moreMessage({
        newPages: 2,
        total: 31,
        pending: { parts: [{ ...fronts, pages: 31 }] },
      }),
    ).toBe("2 more pages, 31 in total.");
  });

  it("filed and discarded", () => {
    expect(filedMessage([{ pages: 19, fileName: "scan-x.pdf" }])).toBe(
      "Filed: 19 pages -> scan-x.pdf",
    );
    expect(
      filedMessage([
        { pages: 29, fileName: "a-vorne.pdf" },
        { pages: 28, fileName: "a-hinten.pdf" },
      ]),
    ).toBe("Filed: 29 + 28 pages -> a-vorne.pdf, a-hinten.pdf");
    expect(discardedMessage(single({ pages: 19 }))).toBe("Discarded 19 pages");
    expect(discardedMessage(single({ pages: 1 }))).toBe("Discarded 1 page");
    expect(discardedMessage(pair)).toBe(
      "Discarded 57 pages (fronts and backs)",
    );
  });
});
