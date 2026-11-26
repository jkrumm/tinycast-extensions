import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPending,
  clearProgress,
  discardPendingFiles,
  partPagePaths,
  partPdfPath,
  pendingDir,
  readPending,
  readProgress,
  readStoredParts,
  StoredPart,
  withPendingLock,
  writePending,
  writeProgress,
} from "./pending";
import { Pending, PendingPart } from "./pending-rules";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pending-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);
const stored = (
  patch: Partial<PendingPart> = {},
  pdf = bytes(1, 2, 3),
  pages = [bytes(10), bytes(20)],
): StoredPart => ({
  part: {
    mode: "feeder",
    fileName: "scan-a.pdf",
    pages: pages.length,
    at: 1000,
    ...patch,
  },
  pdf,
  pages,
});

describe("the pending scan on disk", () => {
  it("is replaced as a whole and read back", () => {
    expect(readPending(dir)).toBeNull();
    writePending(dir, [stored()]);
    expect(readPending(dir)).toEqual({ parts: [stored().part] });
    expect(readStoredParts(dir)).toEqual([stored()]);
    expect(readdirSync(pendingDir(dir)).sort()).toEqual([
      "part-1",
      "scan.json",
    ]);
    expect(readdirSync(join(pendingDir(dir), "part-1")).sort()).toEqual([
      "page-001.jpg",
      "page-002.jpg",
      "scan.pdf",
    ]);

    writePending(dir, [
      stored({ fileName: "scan-b.pdf" }, bytes(9), [bytes(30)]),
    ]);
    expect(readPending(dir)?.parts[0].fileName).toBe("scan-b.pdf");
    expect(readStoredParts(dir)[0].pages).toEqual([bytes(30)]);
    expect(readdirSync(dir)).not.toContain("pending.new");
    expect(readFileSync(partPdfPath(dir, 0))).toEqual(Buffer.from([9]));
  });

  it("holds a fronts/backs pair, each part with its own files", () => {
    const fronts = stored(
      { mode: "fronts", fileName: "a-vorne.pdf" },
      bytes(1),
      [bytes(1)],
    );
    const backs = stored(
      { mode: "backs", fileName: "a-hinten.pdf" },
      bytes(2),
      [bytes(2), bytes(3)],
    );
    writePending(dir, [fronts, backs]);
    expect(readStoredParts(dir)).toEqual([fronts, backs]);
    expect(partPagePaths(dir, 0)).toEqual([
      join(pendingDir(dir), "part-1", "page-001.jpg"),
    ]);
    expect(partPagePaths(dir, 1)).toHaveLength(2);
    expect(partPagePaths(dir, 2)).toEqual([]);
  });

  it("is cleared", () => {
    writePending(dir, [stored()]);
    clearPending(dir);
    expect(readPending(dir)).toBeNull();
    expect(existsSync(pendingDir(dir))).toBe(false);
    expect(readStoredParts(dir)).toEqual([]);
  });

  it("reads as nothing when scan.json is broken", () => {
    mkdirSync(pendingDir(dir));
    writeFileSync(join(pendingDir(dir), "scan.json"), "{nope");
    expect(readPending(dir)).toBeNull();
  });
});

describe("progress", () => {
  it("is written, read and cleared", () => {
    expect(readProgress(dir)).toBeNull();
    writeProgress(dir, { mode: "feeder", page: 4, startedAt: 10, pid: 77 });
    expect(readProgress(dir)).toEqual({
      mode: "feeder",
      page: 4,
      startedAt: 10,
      pid: 77,
    });
    clearProgress(dir);
    expect(readProgress(dir)).toBeNull();
  });

  it("reads as nothing when it is broken", () => {
    writeFileSync(join(dir, "progress.json"), JSON.stringify({ mode: 3 }));
    expect(readProgress(dir)).toBeNull();
  });
});

describe("withPendingLock", () => {
  const deps = (pid: number, alive: number[] = []) => ({
    pid,
    isPidAlive: (p: number) => alive.includes(p),
    sleep: (ms: number) =>
      new Promise<void>((r) => setTimeout(r, Math.min(ms, 2))),
  });

  it("runs one holder at a time", async () => {
    const order: string[] = [];
    const run = (name: string, pid: number) =>
      withPendingLock(dir, deps(pid, [1, 2]), async () => {
        order.push(`${name} in`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${name} out`);
      });
    await Promise.all([run("a", 1), run("b", 2)]);
    expect(order).toEqual(["a in", "a out", "b in", "b out"]);
    expect(existsSync(join(dir, "pending.lock"))).toBe(false);
  });

  it("releases the lock when the work throws", async () => {
    await expect(
      withPendingLock(dir, deps(1), () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(join(dir, "pending.lock"))).toBe(false);
  });

  it("takes over a lock whose process is gone", async () => {
    writeFileSync(join(dir, "pending.lock"), "4242");
    expect(await withPendingLock(dir, deps(1, []), () => "ran")).toBe("ran");
  });
});

describe("discardPendingFiles", () => {
  const pending = (...names: string[]): Pending => ({
    parts: names.map((fileName) => stored({ fileName }).part),
  });

  it("moves the PDFs to discarded/ and clears pending", () => {
    writePending(dir, [stored()]);
    const [target] = discardPendingFiles(dir, pending("scan-a.pdf"));
    expect(target).toBe(join(dir, "discarded", "scan-a.pdf"));
    expect(readFileSync(target)).toEqual(Buffer.from([1, 2, 3]));
    expect(readPending(dir)).toBeNull();
  });

  it("drops both parts of a pair", () => {
    writePending(dir, [
      stored({ mode: "fronts", fileName: "a-vorne.pdf" }),
      stored({ mode: "backs", fileName: "a-hinten.pdf" }),
    ]);
    discardPendingFiles(dir, pending("a-vorne.pdf", "a-hinten.pdf"));
    expect(readdirSync(join(dir, "discarded")).sort()).toEqual([
      "a-hinten.pdf",
      "a-vorne.pdf",
    ]);
  });

  it("never overwrites a file of the same name", () => {
    for (let i = 0; i < 2; i++) {
      writePending(dir, [stored({}, bytes(i))]);
      discardPendingFiles(dir, pending("scan-a.pdf"));
    }
    expect(readdirSync(join(dir, "discarded")).sort()).toEqual([
      "scan-a-2.pdf",
      "scan-a.pdf",
    ]);
  });

  it("keeps the newest five files", () => {
    for (let i = 1; i <= 7; i++) {
      const fileName = `scan-${i}.pdf`;
      writePending(dir, [stored({ fileName })]);
      const [target] = discardPendingFiles(dir, pending(fileName));
      utimesSync(target, 1000 + i, 1000 + i);
    }
    expect(readdirSync(join(dir, "discarded")).sort()).toEqual([
      "scan-3.pdf",
      "scan-4.pdf",
      "scan-5.pdf",
      "scan-6.pdf",
      "scan-7.pdf",
    ]);
  });
});
