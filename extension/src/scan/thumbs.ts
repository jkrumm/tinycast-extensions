// Page thumbnails of a scan: a small JPEG per page, made with `sips`, so the
// Scanner view can show a blank stack or a missing page before Submit. A page
// whose thumbnail cannot be made is `null` — a scan never fails on it.

import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mapLimit, sipsThumbnail } from "./sips";

export interface ThumbPorts {
  convert(src: string, dest: string): Promise<void>;
  readFile(path: string): Uint8Array;
  makeTmpDir(): string;
  remove(path: string): void;
}

const sipsPorts: ThumbPorts = {
  convert: (src, dest) => sipsThumbnail(src, dest),
  readFile: (path) => new Uint8Array(readFileSync(path)),
  makeTmpDir: () => mkdtempSync(join(tmpdir(), "scan-thumbs-")),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

const CONCURRENCY = 4;

// The thumbnail bytes of each page file, in order; `null` where one failed.
export async function makeThumbs(
  pagePaths: string[],
  log: (line: string) => void = () => undefined,
  ports: ThumbPorts = sipsPorts,
): Promise<(Uint8Array | null)[]> {
  const dir = ports.makeTmpDir();
  try {
    return await mapLimit(pagePaths, CONCURRENCY, async (src, index) => {
      const dest = join(dir, `thumb-${String(index + 1).padStart(3, "0")}.jpg`);
      try {
        await ports.convert(src, dest);
        return ports.readFile(dest);
      } catch (error) {
        log(
          `thumb: page ${index + 1} skipped: ${error instanceof Error ? error.message : error}`,
        );
        return null;
      } finally {
        ports.remove(dest);
      }
    });
  } finally {
    ports.remove(dir);
  }
}

// `thumb-003-1a2b3c4d.jpg`: the name carries a hash of the content. Tinycast
// caches a file image by its path, so a thumbnail whose content changed under
// an unchanged path would be shown stale; a new content gets a new name.
export function thumbFileName(index: number, bytes: Uint8Array): string {
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 8);
  return `thumb-${String(index + 1).padStart(3, "0")}-${hash}.jpg`;
}

// The page index a thumbnail file name belongs to, or null.
export function thumbIndex(fileName: string): number | null {
  const match = /^thumb-(\d+)-[0-9a-f]{8}\.jpg$/.exec(fileName);
  return match ? Number(match[1]) - 1 : null;
}
