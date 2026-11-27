import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeDocsFs } from "./docs-fs";
import {
  listDocuments,
  NO_INDEX,
  parseProposedSplit,
  releaseReview,
} from "./documents";
import { documentsResult, releaseResult } from "./inbox-cli";

// The consumer's reason for a stack it could not split with certainty.
const REAL_SPLIT_WHY = [
  "unsure where the stack splits (page 12: 0.65, page 14: 0.75); proposed documents: pages 1-8, 9, 10-11, 12-13, 14-15",
  "proposal: 5 documents, pages 1-8, 9, 10-11, 12-13, 14-15",
  "To decide it without a terminal: move the file out of review/ into the inbox under the name <name>.single.pdf (it is one document) or <name>.split-2-5.pdf (pages 2 and 5 each begin a new document). Values go into the name too: …",
].join("\n");

let root: string;
let inbox: string;
let brain: string;
let docs: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "documents-test-"));
  inbox = join(root, "inbox");
  brain = join(root, "brain");
  docs = join(root, "Dokumente");
  for (const dir of [inbox, join(inbox, "review"), join(inbox, "done"), docs]) {
    mkdirSync(dir, { recursive: true });
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const touch = (path: string, content = "x", mtimeSec?: number): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
};

// Invented documents only: the real index is private.
function note(
  year: string,
  name: string,
  fields: Record<string, string>,
  body: string,
  mtimeSec: number,
): void {
  const front = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  touch(
    join(brain, "Areas", "Documents", year, `${name}.md`),
    `---\n${front}\n---\n${body}\n`,
    mtimeSec,
  );
}

describe("listDocuments: the inbox", () => {
  it("lists documents waiting in the inbox, newest first, without dotfiles and folders", () => {
    touch(join(inbox, "older.pdf"), "aaa", 1000);
    touch(join(inbox, "newer.JPG"), "bb", 2000);
    touch(join(inbox, "scan.heic"), "c", 1500);
    touch(join(inbox, ".hidden.pdf"), "x");
    touch(join(inbox, "notes.txt"), "x");
    touch(join(inbox, ".fin-inbox.lock"), "");
    const result = listDocuments(nodeDocsFs, { inbox });
    if (!result.ok) throw new Error("expected ok");
    expect(result.waiting.map((w) => w.name)).toEqual([
      "newer.JPG",
      "scan.heic",
      "older.pdf",
    ]);
    expect(result.waiting[0]).toEqual({
      name: "newer.JPG",
      path: join(inbox, "newer.JPG"),
      size: 2,
      mtime: 2_000_000,
    });
  });

  it("lists review documents with the text of their .why.txt, not the .why.txt files", () => {
    touch(join(inbox, "review", "unclear.pdf"), "x", 3000);
    touch(
      join(inbox, "review", "unclear.why.txt"),
      "two documents in one file\nproposal: kind letter\n",
    );
    touch(join(inbox, "review", "plain.png"), "x", 2000);
    const result = listDocuments(nodeDocsFs, { inbox });
    if (!result.ok) throw new Error("expected ok");
    expect(result.review).toEqual([
      {
        name: "unclear.pdf",
        path: join(inbox, "review", "unclear.pdf"),
        mtime: 3_000_000,
        why: "two documents in one file\nproposal: kind letter",
      },
      {
        name: "plain.png",
        path: join(inbox, "review", "plain.png"),
        mtime: 2_000_000,
        why: null,
      },
    ]);
  });

  it("lists no .txt next to a review PDF, and hides the collated sides behind their file", () => {
    touch(join(inbox, "review", "scan-2026-01-02-101010.pdf"), "x", 3000);
    touch(join(inbox, "review", "scan-2026-01-02-101010.txt"), "text");
    touch(join(inbox, "review", "scan-2026-01-02-101010-vorne.pdf"), "x", 2000);
    touch(
      join(inbox, "review", "scan-2026-01-02-101010-hinten.pdf"),
      "x",
      1000,
    );
    touch(join(inbox, "review", "other-vorne.pdf"), "x", 500);
    const result = listDocuments(nodeDocsFs, { inbox });
    if (!result.ok) throw new Error("expected ok");
    expect(result.review.map((r) => r.name)).toEqual([
      "scan-2026-01-02-101010.pdf",
      "other-vorne.pdf",
    ]);
  });

  it("reads the consumer's split proposal into the review item", () => {
    touch(join(inbox, "review", "scan-2026-01-02-101010.pdf"), "x");
    touch(
      join(inbox, "review", "scan-2026-01-02-101010.why.txt"),
      REAL_SPLIT_WHY,
    );
    const result = listDocuments(nodeDocsFs, { inbox });
    if (!result.ok) throw new Error("expected ok");
    expect(result.review[0].proposedSplit).toEqual({
      documents: 5,
      ranges: ["1-8", "9", "10-11", "12-13", "14-15"],
      starts: [9, 10, 12, 14],
    });
  });

  it("lists the 10 newest files in done/", () => {
    for (let i = 1; i <= 12; i++)
      touch(join(inbox, "done", `d${i}.pdf`), "x", i);
    const result = listDocuments(nodeDocsFs, { inbox });
    if (!result.ok) throw new Error("expected ok");
    expect(result.done).toHaveLength(10);
    expect(result.done[0].name).toBe("d12.pdf");
    expect(result.done.at(-1)?.name).toBe("d3.pdf");
  });

  it("answers ok:false for a missing inbox", () => {
    expect(listDocuments(nodeDocsFs, { inbox: join(root, "missing") })).toEqual(
      {
        ok: false,
        message: "Scan inbox not found (is the share mounted?)",
      },
    );
  });

  it("works without review/ and done/", () => {
    rmSync(join(inbox, "review"), { recursive: true });
    rmSync(join(inbox, "done"), { recursive: true });
    const result = listDocuments(nodeDocsFs, { inbox });
    expect(result).toMatchObject({
      ok: true,
      waiting: [],
      review: [],
      done: [],
    });
  });
});

describe("listDocuments: the filed documents (index notes)", () => {
  const query = () => ({ inbox, brainDir: brain, dokumenteDir: docs });

  it("reads the notes, newest by date, with the absolute path of the file", () => {
    touch(join(docs, "Finanzen", "gas-march.pdf"), "pdf");
    note(
      "2026",
      "2026-03 Example Gas Invoice",
      {
        kind: "invoice",
        issuer: '"Example Utilities GmbH"',
        date: "2026-03-14",
        tags: "[energy, gas]",
        share_path: "Finanzen/gas-march.pdf",
        sha256: "00",
      },
      "Gas invoice for March.\nDue in 14 days.",
      5000,
    );
    note(
      "2026",
      "2026-05 Example Letter",
      {
        kind: "letter",
        issuer: "Sample Authority",
        date: "2026-05-02",
        share_path: "gone.pdf",
      },
      "A letter.",
      4000,
    );
    const result = listDocuments(nodeDocsFs, query());
    if (!result.ok) throw new Error("expected ok");
    expect(result.filed.map((f) => f.title)).toEqual([
      "2026-05 Example Letter",
      "2026-03 Example Gas Invoice",
    ]);
    expect(result.filed[1]).toEqual({
      title: "2026-03 Example Gas Invoice",
      kind: "invoice",
      issuer: "Example Utilities GmbH",
      date: "2026-03-14",
      tags: ["energy", "gas"],
      summary: "Gas invoice for March. Due in 14 days.",
      path: join(docs, "Finanzen", "gas-march.pdf"),
      notePath: join(
        brain,
        "Areas",
        "Documents",
        "2026",
        "2026-03 Example Gas Invoice.md",
      ),
      exists: true,
    });
    // the file is missing
    expect(result.filed[0].exists).toBe(false);
    // the newest note read
    expect(result.filedAsOf).toBe(5_000_000);
    expect(result.filedNote).toBeUndefined();
  });

  it("sorts by date, then mtime, notes without a date last, and keeps 20", () => {
    for (let i = 1; i <= 22; i++) {
      note(
        "2025",
        `n${String(i).padStart(2, "0")}`,
        { date: `2025-01-${String(i).padStart(2, "0")}` },
        "x",
        i,
      );
    }
    note("2025", "undated-new", {}, "x", 9999);
    note("2024", "same-day-old", { date: "2025-01-22" }, "x", 1);
    const result = listDocuments(nodeDocsFs, query());
    if (!result.ok) throw new Error("expected ok");
    expect(result.filed).toHaveLength(20);
    // same date: the newer file first
    expect(result.filed.slice(0, 2).map((f) => f.title)).toEqual([
      "n22",
      "same-day-old",
    ]);
    expect(result.filed.some((f) => f.title === "undated-new")).toBe(false);
    expect(result.filedAsOf).toBe(9_999_000);
  });

  it("says the index is missing without failing the listing", () => {
    touch(join(inbox, "a.pdf"));
    for (const q of [
      { inbox, brainDir: join(root, "no-brain"), dokumenteDir: docs },
      { inbox },
    ]) {
      const result = listDocuments(nodeDocsFs, q);
      expect(result).toMatchObject({
        ok: true,
        filed: [],
        filedAsOf: null,
        filedNote: NO_INDEX,
      });
      if (result.ok) expect(result.waiting).toHaveLength(1);
    }
  });

  it("has no path when the note has no share_path or no Dokumente dir is given", () => {
    note("2026", "a", { kind: "letter" }, "x", 1);
    const result = listDocuments(nodeDocsFs, { inbox, brainDir: brain });
    if (!result.ok) throw new Error("expected ok");
    expect(result.filed[0]).toMatchObject({ path: "", exists: false });
  });

  it("is what the CLI query returns", () => {
    expect(documentsResult({ inbox })).toEqual(
      listDocuments(nodeDocsFs, { inbox }),
    );
  });
});

describe("parseProposedSplit", () => {
  it("reads the real proposal line verbatim", () => {
    expect(parseProposedSplit(REAL_SPLIT_WHY)).toEqual({
      documents: 5,
      ranges: ["1-8", "9", "10-11", "12-13", "14-15"],
      starts: [9, 10, 12, 14],
    });
  });

  it("reads a two-document proposal and ignores the kind form", () => {
    expect(parseProposedSplit("proposal: 2 documents, pages 1-3, 4")).toEqual({
      documents: 2,
      ranges: ["1-3", "4"],
      starts: [4],
    });
    expect(parseProposedSplit("proposal: kind letter")).toBeNull();
    expect(parseProposedSplit("unclear scan")).toBeNull();
    expect(parseProposedSplit(null)).toBeNull();
  });

  it("accepts no malformed list", () => {
    for (const line of [
      "proposal: 3 documents, pages 1-8, 9",
      "proposal: 2 documents, pages 1-8, 10-11",
      "proposal: 2 documents, pages 1-8, 8-11",
      "proposal: 2 documents, pages 2-8, 9",
      "proposal: 2 documents, pages 9, 1-8",
      "proposal: 1 documents, pages 1-8",
      "proposal: 2 documents, pages 1-8, nine",
      "proposal: 2 documents, pages 1-8, ",
      "proposal: 2 documents, pages 1-8, 9-5",
    ]) {
      expect(parseProposedSplit(line), line).toBeNull();
    }
  });
});

describe("releaseReview", () => {
  const release = (name: string, as = "single") =>
    releaseResult({ inbox, name, as });

  it("moves a held PDF to <stem>.single.pdf and removes its .why.txt", () => {
    touch(join(inbox, "review", "held.pdf"), "pdf");
    touch(join(inbox, "review", "held.why.txt"), "why");
    expect(release("held.pdf")).toEqual({
      ok: true,
      message: "Filed as one document: held.single.pdf",
    });
    expect(readdirSync(inbox).sort()).toEqual([
      "done",
      "held.single.pdf",
      "review",
    ]);
    expect(readdirSync(join(inbox, "review"))).toEqual([]);
  });

  it("refuses anything that is not a plain file name inside review/", () => {
    touch(join(inbox, "outside.pdf"), "x");
    for (const name of [
      "",
      "../outside.pdf",
      "sub/held.pdf",
      "..",
      "a..b.pdf",
      "sub\\held.pdf",
      ".hidden.pdf",
      "/etc/passwd",
    ]) {
      expect(release(name).ok).toBe(false);
    }
    expect(release("../outside.pdf").message).toBe(
      "Not a file name in review/",
    );
    expect(readdirSync(inbox).sort()).toEqual([
      "done",
      "outside.pdf",
      "review",
    ]);
  });

  it("refuses a missing file, a non-PDF, another --as and an existing target", () => {
    expect(release("nothing.pdf")).toEqual({
      ok: false,
      message: "nothing.pdf is not in review/",
    });
    touch(join(inbox, "review", "photo.png"), "x");
    expect(release("photo.png").message).toBe(
      "Only PDF files can be filed as one document",
    );
    touch(join(inbox, "review", "held.pdf"), "x");
    expect(release("held.pdf", "separate").ok).toBe(false);
    touch(join(inbox, "held.single.pdf"), "taken");
    expect(release("held.pdf")).toEqual({
      ok: false,
      message: "held.single.pdf already exists in the inbox",
    });
    expect(readdirSync(join(inbox, "review"))).toContain("held.pdf");
  });

  it("files a proposed split as <stem>.split-<n>-<n>.pdf and drops its .why.txt", () => {
    touch(join(inbox, "review", "scan-2026-01-02-101010.pdf"), "pdf");
    touch(join(inbox, "review", "scan-2026-01-02-101010.why.txt"), "why");
    expect(release("scan-2026-01-02-101010.pdf", "split-9-10-12-14")).toEqual({
      ok: true,
      message:
        "Filed as 5 documents: scan-2026-01-02-101010.split-9-10-12-14.pdf",
    });
    expect(readdirSync(inbox).sort()).toEqual([
      "done",
      "review",
      "scan-2026-01-02-101010.split-9-10-12-14.pdf",
    ]);
    expect(readdirSync(join(inbox, "review"))).toEqual([]);
  });

  it("replaces an earlier .single or .split part instead of stacking it", () => {
    touch(join(inbox, "review", "held.split-5.pdf"), "pdf");
    expect(release("held.split-5.pdf").message).toBe(
      "Filed as one document: held.single.pdf",
    );
    touch(join(inbox, "review", "held.single.pdf"), "pdf");
    expect(release("held.single.pdf", "split-2-5").message).toBe(
      "Filed as 3 documents: held.split-2-5.pdf",
    );
  });

  it("refuses a malformed split in one line, and an existing split target", () => {
    touch(join(inbox, "review", "held.pdf"), "x");
    const tooMany = (n: number) =>
      `split-${Array.from({ length: n }, (_, i) => i + 2).join("-")}`;
    for (const as of [
      "split-",
      "split-1",
      "split-5-3",
      "split-5-5",
      "split-2-x",
      "split-0-4",
      "split-2-1-3",
      tooMany(51),
    ]) {
      const result = release("held.pdf", as);
      expect(result.ok, as).toBe(false);
      expect(result.message, as).toMatch(
        /^Split needs up to 50 page numbers from 2, strictly ascending/,
      );
    }
    expect(release("held.pdf", "separate").message).toBe(
      "Only --as single or --as split-<n>-<n>… is supported",
    );
    touch(join(inbox, "held.split-9.pdf"), "taken");
    expect(release("held.pdf", "split-9")).toEqual({
      ok: false,
      message: "held.split-9.pdf already exists in the inbox",
    });
    expect(release("held.pdf", tooMany(50)).ok).toBe(true);
    expect(readdirSync(join(inbox, "review"))).toEqual([]);
  });

  it("works on the pure function with a fake fs too", () => {
    const calls: string[] = [];
    const fs = {
      list: (dir: string) =>
        dir.endsWith("review")
          ? [{ name: "a.pdf", isFile: true, isDir: false, size: 1, mtimeMs: 1 }]
          : null,
      readText: () => null,
      exists: () => false,
      rename: (a: string, b: string) => void calls.push(`mv ${a} ${b}`),
      remove: (p: string) => void calls.push(`rm ${p}`),
    };
    expect(
      releaseReview(fs, { inbox: "/in", name: "a.pdf", as: "single" }).ok,
    ).toBe(true);
    expect(calls).toEqual([
      "mv /in/review/a.pdf /in/a.single.pdf",
      "rm /in/review/a.why.txt",
    ]);
  });
});
