import { describe, expect, it } from "vitest";
import {
  DOC_THUMB_CONCURRENCY,
  DOC_THUMB_MAX_AGE_MS,
  DocThumbPorts,
  makeDocThumbs,
  thumbKey,
} from "./doc-thumbs";

function makePorts(opts: {
  files?: Record<string, { mtimeMs: number; size: number }>;
  cached?: Set<string>;
  failing?: Set<string>;
  cache?: { name: string; mtimeMs: number }[];
}) {
  const converted: [string, string][] = [];
  const removed: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const ports: DocThumbPorts = {
    stat: (path) => opts.files?.[path] ?? null,
    exists: (path) => opts.cached?.has(path) ?? false,
    mkdirp: () => undefined,
    convert: async (src, dest) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (opts.failing?.has(src)) throw new Error("sips failed");
      converted.push([src, dest]);
    },
    listCache: () => opts.cache ?? [],
    remove: (path) => void removed.push(path),
  };
  return { ports, converted, removed, max: () => maxRunning };
}

const file = { mtimeMs: 10, size: 5 };

describe("makeDocThumbs", () => {
  it("makes a cached thumbnail named by path, mtime and size", async () => {
    const { ports, converted } = makePorts({ files: { "/in/a.pdf": file } });
    const result = await makeDocThumbs(ports, {
      stateDir: "/state",
      paths: ["/in/a.pdf"],
      nowMs: 1000,
    });
    const dest = `/state/doc-thumbs/${thumbKey("/in/a.pdf", 10, 5)}.jpg`;
    expect(result).toEqual([{ path: "/in/a.pdf", thumbPath: dest }]);
    expect(converted).toEqual([["/in/a.pdf", dest]]);
  });

  it("names a changed file differently, so Tinycast's path cache cannot show it stale", () => {
    expect(thumbKey("/a.pdf", 10, 5)).not.toBe(thumbKey("/a.pdf", 11, 5));
    expect(thumbKey("/a.pdf", 10, 5)).not.toBe(thumbKey("/a.pdf", 10, 6));
    expect(thumbKey("/a.pdf", 10, 5)).toBe(thumbKey("/a.pdf", 10, 5));
  });

  it("does not make a thumbnail twice", async () => {
    const dest = `/state/doc-thumbs/${thumbKey("/in/a.pdf", 10, 5)}.jpg`;
    const { ports, converted } = makePorts({
      files: { "/in/a.pdf": file },
      cached: new Set([dest]),
    });
    const result = await makeDocThumbs(ports, {
      stateDir: "/state",
      paths: ["/in/a.pdf", "/in/a.pdf"],
      nowMs: 1,
    });
    expect(result).toHaveLength(1);
    expect(converted).toEqual([]);
  });

  it("skips failures, missing files and non-documents", async () => {
    const { ports, removed } = makePorts({
      files: { "/in/a.pdf": file, "/in/b.png": file, "/in/c.txt": file },
      failing: new Set(["/in/a.pdf"]),
    });
    const result = await makeDocThumbs(ports, {
      stateDir: "/state",
      paths: ["/in/a.pdf", "/in/b.png", "/in/gone.pdf", "/in/c.txt"],
      nowMs: 1,
    });
    expect(result.map((r) => r.path)).toEqual(["/in/b.png"]);
    expect(removed).toContain(
      `/state/doc-thumbs/${thumbKey("/in/a.pdf", 10, 5)}.jpg`,
    );
  });

  it("runs at most four sips at a time", async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/in/${i}.pdf`);
    const files = Object.fromEntries(paths.map((p) => [p, file]));
    const { ports, max } = makePorts({ files });
    await makeDocThumbs(ports, { stateDir: "/s", paths, nowMs: 1 });
    expect(max()).toBe(DOC_THUMB_CONCURRENCY);
    expect(DOC_THUMB_CONCURRENCY).toBe(4);
  });

  it("prunes cache files older than 30 days", async () => {
    const now = 100 * 24 * 3600_000;
    const { ports, removed } = makePorts({
      cache: [
        { name: "old.jpg", mtimeMs: now - DOC_THUMB_MAX_AGE_MS - 1 },
        { name: "fresh.jpg", mtimeMs: now - DOC_THUMB_MAX_AGE_MS + 1000 },
      ],
    });
    await makeDocThumbs(ports, { stateDir: "/state", paths: [], nowMs: now });
    expect(removed).toEqual(["/state/doc-thumbs/old.jpg"]);
  });
});
