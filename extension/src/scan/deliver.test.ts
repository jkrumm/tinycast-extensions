import { describe, expect, it } from "vitest";
import { DeliverFs, deliverPdf, keepPdf } from "./deliver";

// An in-memory filesystem; `failCopy` makes the copy into a directory throw,
// `shortCopy` writes a truncated destination.
function makeFs(opts: { failCopy?: string; shortCopy?: boolean } = {}) {
  const files = new Map<string, number>([["/tmp/x/scan.pdf", 1000]]);
  const dirs: string[] = [];
  const removed: string[] = [];
  const fs: DeliverFs = {
    async copyExclusive(src, dest) {
      if (opts.failCopy && dest.startsWith(`${opts.failCopy}/`)) {
        throw Object.assign(new Error("Input/output error"), { code: "EIO" });
      }
      if (files.has(dest)) {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      files.set(dest, opts.shortCopy ? 10 : files.get(src)!);
    },
    async size(path) {
      return files.get(path) ?? 0;
    },
    async mkdirp(dir) {
      dirs.push(dir);
    },
    async remove(path) {
      removed.push(path);
      files.delete(path);
    },
  };
  return { fs, files, dirs, removed };
}

const opts = {
  src: "/tmp/x/scan.pdf",
  outDir: "/inbox",
  keepDir: "/state/unsent",
  fileName: "scan-1.pdf",
};

describe("deliverPdf", () => {
  it("copies into the inbox and verifies the size", async () => {
    const { fs, files } = makeFs();
    expect(await deliverPdf(fs, opts)).toEqual({
      kind: "sent",
      path: "/inbox/scan-1.pdf",
    });
    expect(files.has("/inbox/scan-1.pdf")).toBe(true);
  });

  it("never overwrites: -2, -3 before .pdf", async () => {
    const { fs, files } = makeFs();
    files.set("/inbox/scan-1.pdf", 5);
    files.set("/inbox/scan-1-2.pdf", 5);
    expect(await deliverPdf(fs, opts)).toMatchObject({
      kind: "sent",
      path: "/inbox/scan-1-3.pdf",
    });
    expect(files.get("/inbox/scan-1.pdf")).toBe(5);
  });

  it("keeps the PDF in the unsent folder when the copy throws", async () => {
    const { fs, files, dirs } = makeFs({ failCopy: "/inbox" });
    const result = await deliverPdf(fs, opts);
    expect(result).toEqual({
      kind: "kept",
      path: "/state/unsent/scan-1.pdf",
      error: "Input/output error",
    });
    expect(dirs).toEqual(["/state/unsent"]);
    expect(files.has("/state/unsent/scan-1.pdf")).toBe(true);
    // the source is left for the caller, which removes its temp dir only now
    expect(files.has(opts.src)).toBe(true);
  });

  it("treats a short copy as a failure and removes the truncated file", async () => {
    const { fs, files, removed } = makeFs({ shortCopy: true });
    // the unsent copy is short too, so delivery fails as a whole
    await expect(deliverPdf(fs, opts)).rejects.toThrow(/Copy incomplete/);
    expect(removed).toContain("/inbox/scan-1.pdf");
    expect(files.has("/inbox/scan-1.pdf")).toBe(false);
  });

  it("throws when even the unsent folder cannot take it", async () => {
    const { fs } = makeFs({ failCopy: "/inbox" });
    const broken: DeliverFs = {
      ...fs,
      mkdirp: async () => {
        throw new Error("read-only");
      },
    };
    await expect(deliverPdf(broken, opts)).rejects.toThrow("read-only");
  });
});

describe("keepPdf", () => {
  it("creates the folder and keeps the file", async () => {
    const { fs, dirs, files } = makeFs();
    expect(
      await keepPdf(fs, {
        src: opts.src,
        dir: "/state/partial",
        fileName: "scan-1.pdf",
      }),
    ).toBe("/state/partial/scan-1.pdf");
    expect(dirs).toEqual(["/state/partial"]);
    expect(files.has("/state/partial/scan-1.pdf")).toBe(true);
  });
});
