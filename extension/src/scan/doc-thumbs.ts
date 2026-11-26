// Thumbnails of the documents the Scanner view lists (waiting, review, filed):
// the first page of a PDF or an image, reduced with `sips` and cached in the
// state dir under a hash of path + mtime + size, so a changed file gets a new
// name (Tinycast caches a file image by its path). At most four `sips` run at
// once; a failure is skipped; cache files older than 30 days are pruned.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { isDocumentName } from "./documents";
import { mapLimit, sipsThumbnail } from "./sips";

export interface DocThumbPorts {
  stat(path: string): { mtimeMs: number; size: number } | null;
  exists(path: string): boolean;
  mkdirp(dir: string): void;
  convert(src: string, dest: string): Promise<void>;
  listCache(dir: string): { name: string; mtimeMs: number }[];
  remove(path: string): void;
}

export const DOC_THUMB_CONCURRENCY = 4;
export const DOC_THUMB_MAX_AGE_MS = 30 * 24 * 3600_000;

export const thumbKey = (path: string, mtimeMs: number, size: number): string =>
  createHash("sha1").update(`${path}\0${mtimeMs}\0${size}`).digest("hex");

export interface DocThumb {
  path: string; // the document
  thumbPath: string; // its thumbnail in the cache
}

export async function makeDocThumbs(
  ports: DocThumbPorts,
  opts: { stateDir: string; paths: string[]; nowMs: number },
): Promise<DocThumb[]> {
  const dir = join(opts.stateDir, "doc-thumbs");
  ports.mkdirp(dir);
  const unique = [...new Set(opts.paths)].filter((p) =>
    isDocumentName(p.split("/").pop() ?? ""),
  );

  const made = await mapLimit(unique, DOC_THUMB_CONCURRENCY, async (path) => {
    const st = ports.stat(path);
    if (!st) return null;
    const thumbPath = join(dir, `${thumbKey(path, st.mtimeMs, st.size)}.jpg`);
    if (!ports.exists(thumbPath)) {
      try {
        await ports.convert(path, thumbPath);
      } catch {
        ports.remove(thumbPath);
        return null;
      }
    }
    return { path, thumbPath };
  });

  for (const file of ports.listCache(dir)) {
    if (opts.nowMs - file.mtimeMs > DOC_THUMB_MAX_AGE_MS) {
      ports.remove(join(dir, file.name));
    }
  }
  return made.filter((m): m is DocThumb => m !== null);
}

export const nodeDocThumbPorts: DocThumbPorts = {
  stat(path) {
    try {
      const s = statSync(path);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  },
  exists: (path) => existsSync(path),
  mkdirp: (dir) => void mkdirSync(dir, { recursive: true }),
  convert: (src, dest) => sipsThumbnail(src, dest),
  listCache(dir) {
    try {
      return readdirSync(dir).map((name) => ({
        name,
        mtimeMs: statSync(join(dir, name)).mtimeMs,
      }));
    } catch {
      return [];
    }
  },
  remove: (path) => rmSync(path, { force: true }),
};
