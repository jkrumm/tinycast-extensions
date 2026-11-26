import { describe, expect, it } from "vitest";
import {
  DOCUMENTS_UNREADABLE,
  DocumentsResult,
  FiledDoc,
  POLL_AFTER_ACTION_MS,
  POLL_IDLE_MS,
  POLL_SCANNING_MS,
  ReviewDoc,
  ScanStatus,
  WaitingDoc,
  attentionTile,
  clockTime,
  documentSignature,
  filedDetailMarkdown,
  filedSectionTitle,
  filedTile,
  formatBytes,
  isScanning,
  pageTitle,
  parseDocThumbs,
  parseDocuments,
  parseStatus,
  partTitle,
  pendingPageCount,
  pollInterval,
  proposalKind,
  resultToToast,
  reviewDetailMarkdown,
  reviewTile,
  scannerActions,
  scanningTitle,
  submitConfirmation,
  thumbMap,
  tileStatus,
  waitingDetailMarkdown,
  waitingTile,
} from "./view";

type Part = NonNullable<ScanStatus["pending"]>["parts"][number];
const part = (mode: string, pages: number): Part => ({
  mode,
  fileName: `${mode}.pdf`,
  pages,
  at: 1,
  pagePaths: Array.from(
    { length: pages },
    (_, i) => `/s/${mode}/page-${i + 1}.jpg`,
  ),
  thumbPaths: Array.from({ length: pages }, (_, i) =>
    i === 1 ? null : `/s/${mode}/thumb-${i + 1}.jpg`,
  ),
  pdfPath: `/s/${mode}/scan.pdf`,
});
const pending = (scanning: boolean, ...parts: Part[]): ScanStatus => ({
  pending: { parts, scanning, needsAttention: false },
});
const attention = (message: string, ...parts: Part[]): ScanStatus => ({
  pending: { parts, scanning: false, needsAttention: true, attention: message },
});
const idle: ScanStatus = { pending: null };
const running: ScanStatus = {
  pending: null,
  progress: { mode: "feeder", page: 5, startedAt: 1, pid: 7 },
};
const ids = (status: ScanStatus | undefined) =>
  scannerActions(status).map((a) => a.id);

describe("scannerActions", () => {
  it("offers the three scans when nothing is pending", () => {
    expect(ids(idle)).toEqual([
      "scan-document",
      "scan-fronts",
      "scan-flatbed",
      "open-log",
      "refresh",
    ]);
    expect(ids(undefined)).toEqual(ids(idle));
  });

  it("offers Submit first for a single pending part, new scans in their own group", () => {
    for (const mode of ["feeder", "flatbed"]) {
      const actions = scannerActions(pending(false, part(mode, 3)));
      expect(actions.map((a) => a.id)).toEqual([
        "submit",
        "scan-more",
        "discard",
        "scan-document",
        "scan-fronts",
        "scan-flatbed",
        "open-log",
        "refresh",
      ]);
      expect(
        actions.filter((a) => a.group === "new-scan").map((a) => a.id),
      ).toEqual(["scan-document", "scan-fronts", "scan-flatbed"]);
      expect(actions.at(-1)?.group).toBe("footer");
      expect(actions[0].group).toBe("main");
    }
  });

  it("offers Scan Backs first for pending fronts, and Submit Fronts Only", () => {
    expect(ids(pending(false, part("fronts", 3)))).toEqual([
      "scan-backs",
      "scan-more",
      "submit-fronts",
      "discard",
      "open-log",
      "refresh",
    ]);
  });

  it("offers Submit first for fronts + backs", () => {
    expect(ids(pending(false, part("fronts", 3), part("backs", 2)))).toEqual([
      "submit",
      "scan-more",
      "discard",
      "open-log",
      "refresh",
    ]);
  });

  it("offers no scan action while scanning", () => {
    expect(ids(running)).toEqual(["open-log", "refresh"]);
    expect(ids(pending(true, part("feeder", 3)))).toEqual([
      "open-log",
      "refresh",
    ]);
  });
});

describe("status helpers", () => {
  it("knows when a scan runs", () => {
    expect(isScanning(idle)).toBe(false);
    expect(isScanning(undefined)).toBe(false);
    expect(isScanning(running)).toBe(true);
    expect(isScanning(pending(true, part("feeder", 1)))).toBe(true);
  });

  it("titles the view and the hub tile", () => {
    expect(scanningTitle(idle)).toBeNull();
    expect(scanningTitle(running)).toBe("Scanning… page 5");
    expect(
      scanningTitle({
        pending: null,
        progress: { mode: "feeder", page: 0, startedAt: 1, pid: 1 },
      }),
    ).toBe("Scanning…");
    expect(tileStatus(idle)).toBe("Ready");
    expect(tileStatus(running)).toBe("Scanning…");
    expect(tileStatus(pending(false, part("feeder", 17)))).toBe(
      "17 pages pending",
    );
    expect(tileStatus(pending(false, part("feeder", 1)))).toBe(
      "1 page pending",
    );
    expect(
      tileStatus(pending(false, part("fronts", 3), part("backs", 2))),
    ).toBe("5 pages pending");
    expect(pendingPageCount(idle)).toBe(0);
  });

  it("titles the sections and the pages", () => {
    const parts = [part("fronts", 17), part("backs", 16)];
    expect(partTitle([part("feeder", 17)], 0)).toBe("Scan · 17 pages");
    expect(partTitle([part("flatbed", 1)], 0)).toBe("Scan · 1 page");
    expect(partTitle(parts, 0)).toBe("Fronts · 17 pages");
    expect(partTitle(parts, 1)).toBe("Backs · 16 pages (fronts had 17)");
    expect(partTitle([part("fronts", 3), part("backs", 3)], 1)).toBe(
      "Backs · 3 pages",
    );
    expect(pageTitle(2)).toBe("Page 3");
  });

  it("polls every 2 s while scanning or just after an action, else every 10 s", () => {
    expect(pollInterval({ status: idle, fastUntil: 0, now: 100 })).toBe(
      POLL_IDLE_MS,
    );
    expect(pollInterval({ status: undefined, fastUntil: 0, now: 100 })).toBe(
      POLL_IDLE_MS,
    );
    expect(pollInterval({ status: running, fastUntil: 0, now: 100 })).toBe(
      POLL_SCANNING_MS,
    );
    expect(pollInterval({ status: idle, fastUntil: 200, now: 100 })).toBe(
      POLL_SCANNING_MS,
    );
    expect(pollInterval({ status: idle, fastUntil: 100, now: 100 })).toBe(
      POLL_IDLE_MS,
    );
    expect(POLL_SCANNING_MS).toBe(2000);
    expect(POLL_IDLE_MS).toBe(10_000);
    expect(POLL_AFTER_ACTION_MS).toBeGreaterThan(POLL_SCANNING_MS);
  });
});

describe("a failed Scan More", () => {
  const blank =
    "Scan stopped: all 3 pages look blank. Stack upside down? PDF kept in ~/.local/state/scan/blank";

  it("titles the first section only", () => {
    const parts = [part("fronts", 3), part("backs", 2)];
    expect(partTitle(parts, 0, true)).toBe(
      "Fronts · 3 pages · last batch failed",
    );
    expect(partTitle(parts, 1, true)).toBe("Backs · 2 pages (fronts had 3)");
    expect(partTitle(parts, 0, false)).toBe("Fronts · 3 pages");
  });

  it("makes a warning tile with the message truncated to fit", () => {
    expect(attentionTile(idle)).toBeNull();
    expect(attentionTile(pending(false, part("feeder", 3)))).toBeNull();
    const tile = attentionTile(attention(blank, part("feeder", 26)));
    expect(tile?.title).toBe("Last batch failed");
    expect(tile?.subtitle).toMatch(/^Scan stopped: all 3 pages look blank.*…$/);
    expect(tile?.subtitle.length).toBeLessThanOrEqual(60);
    expect(
      attentionTile(attention("Scanner is busy", part("feeder", 3)))?.subtitle,
    ).toBe("Scanner is busy");
  });

  it("asks before Submit only in that state", () => {
    expect(submitConfirmation(pending(false, part("feeder", 26)))).toBeNull();
    expect(submitConfirmation(idle)).toBeNull();
    expect(
      submitConfirmation(attention("Scanner is busy.", part("feeder", 26))),
    ).toEqual({
      title: "File without the last batch?",
      message:
        "The last batch failed: Scanner is busy. File the 26 pages without it?",
    });
  });

  it("parses needsAttention, attention and lastResult from --status", () => {
    const status = parseStatus(
      JSON.stringify({
        pending: {
          parts: [part("feeder", 2)],
          scanning: false,
          needsAttention: true,
          attention: "boom",
        },
        lastResult: {
          at: 5,
          action: "more",
          ok: false,
          message: "boom",
          pages: 2,
        },
      }),
    );
    expect(status?.pending).toMatchObject({
      needsAttention: true,
      attention: "boom",
    });
    expect(status?.lastResult).toEqual({
      at: 5,
      action: "more",
      ok: false,
      message: "boom",
      pages: 2,
    });
    // an older CLI without the fields
    const old = parseStatus(
      JSON.stringify({
        pending: { parts: [part("feeder", 2)], scanning: false },
      }),
    );
    expect(old?.pending?.needsAttention).toBe(false);
    expect(old?.lastResult).toBeUndefined();
    expect(parseStatus('{"pending":null,"lastResult":{"at":"x"}}')).toEqual({
      pending: null,
    });
  });

  const result = (at: number, action = "more", ok = false) => ({
    at,
    action,
    ok,
    message: "m",
  });

  it("toasts only a result newer than the one the view opened with", () => {
    // the first answer is the baseline, whatever it holds
    expect(resultToToast(result(100), null)).toEqual({
      toast: null,
      seenAt: 100,
    });
    expect(resultToToast(undefined, null)).toEqual({ toast: null, seenAt: 0 });
    // the same one again
    expect(resultToToast(result(100), 100)).toEqual({
      toast: null,
      seenAt: 100,
    });
    // a new one, success or failure
    expect(resultToToast(result(200, "feeder", true), 100)).toEqual({
      toast: result(200, "feeder", true),
      seenAt: 200,
    });
    expect(resultToToast(result(300), 200).toast).toEqual(result(300));
    // a result vanishing does not toast or reset
    expect(resultToToast(undefined, 200)).toEqual({ toast: null, seenAt: 200 });
    // Submit and Discard are shown by the view itself: seen, not toasted again
    expect(resultToToast(result(400, "submit", true), 300)).toEqual({
      toast: null,
      seenAt: 400,
    });
    expect(resultToToast(result(500, "discard", true), 400).toast).toBeNull();
  });
});

describe("parseStatus", () => {
  const line = (v: unknown) => `${JSON.stringify(v)}\n`;

  it("reads nothing pending, with and without progress", () => {
    expect(parseStatus(line({ pending: null }))).toEqual({ pending: null });
    expect(
      parseStatus(
        line({
          pending: null,
          progress: { mode: "feeder", page: 2, startedAt: 1, pid: 3 },
        }),
      ),
    ).toEqual({
      pending: null,
      progress: { mode: "feeder", page: 2, startedAt: 1, pid: 3 },
    });
  });

  it("reads pending parts", () => {
    const p = pending(true, part("fronts", 3));
    expect(parseStatus(line(p))).toEqual(p);
  });

  it("fills a missing thumbPaths with nulls and tolerates odd entries", () => {
    const p = part("feeder", 2) as Record<string, unknown>;
    delete p.thumbPaths;
    const status = parseStatus(
      line({ pending: { parts: [p], scanning: false } }),
    );
    expect(status?.pending?.parts[0].thumbPaths).toEqual([null, null]);
  });

  it("is null for anything else", () => {
    for (const bad of [
      "",
      "x",
      "{",
      "{}",
      line({ pending: { parts: "no" } }),
      line({ pending: { parts: [{ mode: 1 }] } }),
    ]) {
      expect(parseStatus(bad)).toBeNull();
    }
  });
});

describe("parseDocuments / parseDocThumbs", () => {
  it("reads a listing, ignoring done", () => {
    const filed: FiledDoc = {
      title: "t",
      kind: "invoice",
      issuer: "Example AG",
      date: "2026-03-14",
      tags: ["a"],
      summary: "s",
      path: "/d/t.pdf",
      notePath: "/b/t.md",
      exists: true,
    };
    const result = parseDocuments(
      JSON.stringify({
        ok: true,
        waiting: [{ name: "w.pdf", path: "/in/w.pdf", size: 5, mtime: 9 }],
        review: [
          { name: "r.pdf", path: "/in/review/r.pdf", mtime: 8, why: "x" },
        ],
        done: [{ name: "d.pdf", path: "/d", mtime: 1 }],
        filed: [filed],
        filedAsOf: 7,
        filedNote: undefined,
      }),
    );
    expect(result).toEqual({
      ok: true,
      waiting: [{ name: "w.pdf", path: "/in/w.pdf", size: 5, mtime: 9 }],
      review: [{ name: "r.pdf", path: "/in/review/r.pdf", mtime: 8, why: "x" }],
      done: [],
      filed: [filed],
      filedAsOf: 7,
      filedNote: undefined,
    });
  });

  it("passes a failure message on and turns garbage into a plain failure", () => {
    expect(
      parseDocuments(
        '{"ok":false,"message":"Scan inbox not found (is the share mounted?)"}',
      ),
    ).toEqual({
      ok: false,
      message: "Scan inbox not found (is the share mounted?)",
    });
    expect(parseDocuments("nope")).toEqual({
      ok: false,
      message: DOCUMENTS_UNREADABLE,
    });
  });

  it("reads the thumbnail map", () => {
    const thumbs = parseDocThumbs(
      JSON.stringify({
        thumbs: [{ path: "/a.pdf", thumbPath: "/c/1.jpg" }, { path: 1 }],
      }),
    );
    expect(thumbs).toEqual([{ path: "/a.pdf", thumbPath: "/c/1.jpg" }]);
    expect(thumbMap(thumbs)).toEqual({ "/a.pdf": "/c/1.jpg" });
    expect(thumbMap(undefined)).toEqual({});
    expect(parseDocThumbs("")).toEqual([]);
  });
});

const filed = (patch: Partial<FiledDoc> = {}): FiledDoc => ({
  title: "2026-03 Example Gas Invoice",
  kind: "invoice",
  issuer: "Example Utilities GmbH",
  date: "2026-03-14",
  tags: ["energy", "gas"],
  summary: "Gas invoice for March.",
  path: "/Dokumente/gas.pdf",
  notePath: "/brain/Areas/Documents/2026/gas.md",
  exists: true,
  ...patch,
});
const review = (why: string | null): ReviewDoc => ({
  name: "held.pdf",
  path: "/in/review/held.pdf",
  mtime: 1,
  why,
});
const waiting: WaitingDoc = {
  name: "new.pdf",
  path: "/in/new.pdf",
  size: 120_000,
  mtime: 2,
};

describe("document tiles", () => {
  it("filed: issuer as title (fallback the title), kind · date, search keywords", () => {
    expect(filedTile(filed())).toEqual({
      title: "Example Utilities GmbH",
      subtitle: "invoice · 2026-03-14",
      keywords: [
        "2026-03 Example Gas Invoice",
        "Example Utilities GmbH",
        "invoice",
        "energy",
        "gas",
      ],
      openable: true,
    });
    expect(filedTile(filed({ issuer: "" })).title).toBe(
      "2026-03 Example Gas Invoice",
    );
    expect(filedTile(filed({ kind: "", date: "" })).subtitle).toBe("filed");
    expect(filedTile(filed({ date: "" })).subtitle).toBe("invoice");
  });

  it("filed with a missing file says so and cannot be opened", () => {
    expect(filedTile(filed({ exists: false }))).toMatchObject({
      subtitle: "file not found",
      openable: false,
    });
  });

  it("review: the file name, the proposed kind or needs review", () => {
    expect(
      reviewTile(review("two documents\nproposal: kind letter")),
    ).toMatchObject({
      title: "held.pdf",
      subtitle: "letter",
    });
    expect(reviewTile(review("unclear scan")).subtitle).toBe("needs review");
    expect(reviewTile(review(null)).subtitle).toBe("needs review");
    expect(proposalKind("  Proposal: kind invoice  ")).toBe("invoice");
    expect(proposalKind("no proposal here")).toBeNull();
  });

  it("waiting: the file name and waiting", () => {
    expect(waitingTile(waiting)).toEqual({
      title: "new.pdf",
      subtitle: "waiting",
      keywords: ["new.pdf"],
      openable: true,
    });
  });
});

describe("document lists", () => {
  it("titles the filed section with the time of the newest note", () => {
    const at = new Date(2026, 10, 26, 14, 20).getTime();
    expect(clockTime(at)).toBe("14:20");
    expect(filedSectionTitle(at)).toBe("Recently filed · as of 14:20");
    expect(filedSectionTitle(null)).toBe("Recently filed");
  });

  it("signs the list so thumbnails are fetched only when it changed", () => {
    const base: DocumentsResult = {
      ok: true,
      waiting: [waiting],
      review: [review(null)],
      done: [],
      filed: [filed(), filed({ path: "/gone.pdf", exists: false })],
      filedAsOf: 1,
    };
    const signature = documentSignature(base);
    expect(signature).toContain("/in/new.pdf:2");
    expect(signature).toContain("/Dokumente/gas.pdf");
    expect(signature).not.toContain("/gone.pdf");
    expect(documentSignature({ ...base, filedAsOf: 99 })).toBe(signature);
    expect(documentSignature({ ...base, waiting: [] })).not.toBe(signature);
    expect(documentSignature({ ok: false, message: "x" })).toBe("");
    expect(documentSignature(undefined)).toBe("");
  });
});

describe("detail texts", () => {
  it("filed: title, a small table, the summary and the path", () => {
    const md = filedDetailMarkdown(filed({ issuer: "Example | Partners" }));
    expect(md).toContain("# 2026-03 Example Gas Invoice");
    expect(md).toContain("| Kind | invoice |");
    expect(md).toContain("| Issuer | Example \\| Partners |");
    expect(md).toContain("| Tags | energy, gas |");
    expect(md).toContain("Gas invoice for March.");
    expect(md).toContain("`/Dokumente/gas.pdf`");
    expect(filedDetailMarkdown(filed({ exists: false }))).toContain(
      "(file not found)",
    );
    expect(
      filedDetailMarkdown(
        filed({
          kind: "",
          issuer: "",
          date: "",
          tags: [],
          summary: "",
          path: "",
        }),
      ),
    ).toContain("No file path");
  });

  it("review: the why text as a block and one sentence about the fix", () => {
    const md = reviewDetailMarkdown(
      review("two documents in one file\nproposal: kind letter"),
    );
    expect(md).toContain(
      "> two documents in one file\n> proposal: kind letter",
    );
    expect(md).toContain("proposes **letter**");
    expect(md).toContain("File as One Document");
    expect(reviewDetailMarkdown(review(null))).toContain(
      "> The consumer gave no reason.",
    );
  });

  it("waiting: size and arrival", () => {
    const md = waitingDetailMarkdown(waiting);
    expect(md).toContain("# new.pdf");
    expect(md).toContain("| Size | 120 kB |");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
    expect(formatBytes(10)).toBe("1 kB");
  });
});
