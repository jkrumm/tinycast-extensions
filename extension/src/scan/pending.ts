// The pending scan on disk, in the state dir: `pending/scan.json` (the
// `Pending` of pending-rules.ts) and one `pending/part-<n>/` per part with its
// `scan.pdf` and page JPEGs (page-001.jpg …). It is replaced as a whole
// (staged in `pending.new/`, then swapped in) and every mutation happens under
// a short lock file, so a Submit and a Discard can never both act on it. Also
// here: `progress.json`, what a running scan reports for a UI. Plain sync fs.

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { parsePending, Pending, PendingPart } from "./pending-rules";
import { thumbFileName, thumbIndex } from "./thumbs";

export const pendingDir = (stateDir: string): string =>
  join(stateDir, "pending");
const pendingJson = (dir: string): string => join(dir, "scan.json");
const pendingLockPath = (stateDir: string): string =>
  join(stateDir, "pending.lock");
export const partDir = (stateDir: string, index: number): string =>
  join(pendingDir(stateDir), `part-${index + 1}`);
export const partPdfPath = (stateDir: string, index: number): string =>
  join(partDir(stateDir, index), "scan.pdf");

export function readPending(stateDir: string): Pending | null {
  try {
    return parsePending(
      JSON.parse(readFileSync(pendingJson(pendingDir(stateDir)), "utf8")),
    );
  } catch {
    return null;
  }
}

// The page JPEGs of a part, in page order (absolute paths).
export function partPagePaths(stateDir: string, index: number): string[] {
  try {
    return readdirSync(partDir(stateDir, index))
      .filter((name) => /^page-\d+\.jpg$/.test(name))
      .sort()
      .map((name) => join(partDir(stateDir, index), name));
  } catch {
    return [];
  }
}

// The thumbnail files of a part, aligned to its pages (`null`: none made).
export function partThumbPaths(
  stateDir: string,
  index: number,
  pageCount: number,
): (string | null)[] {
  const paths: (string | null)[] = new Array(pageCount).fill(null);
  try {
    for (const name of readdirSync(partDir(stateDir, index))) {
      const at = thumbIndex(name);
      if (at !== null && at < pageCount) {
        paths[at] = join(partDir(stateDir, index), name);
      }
    }
  } catch {
    // no part dir: no thumbnails
  }
  return paths;
}

// A part with its files in memory (a scan is a few MB). `thumbs` are aligned
// to `pages`; absent or `null` where no thumbnail was made.
export interface StoredPart {
  part: PendingPart;
  pdf: Uint8Array;
  pages: Uint8Array[];
  thumbs?: (Uint8Array | null)[];
}

export function readStoredParts(stateDir: string): StoredPart[] {
  const pending = readPending(stateDir);
  if (!pending) return [];
  return pending.parts.map((part, index) => ({
    part,
    pdf: new Uint8Array(readFileSync(partPdfPath(stateDir, index))),
    pages: partPagePaths(stateDir, index).map(
      (path) => new Uint8Array(readFileSync(path)),
    ),
    thumbs: partThumbPaths(stateDir, index, part.pages).map((path) =>
      path ? new Uint8Array(readFileSync(path)) : null,
    ),
  }));
}

// Replaces pending/ as a whole. scan.json is written last, so a crash midway
// leaves either the old scan or none, never a half-written one.
export function writePending(stateDir: string, parts: StoredPart[]): void {
  const staging = join(stateDir, "pending.new");
  rmSync(staging, { recursive: true, force: true });
  parts.forEach((stored, index) => {
    const dir = join(staging, `part-${index + 1}`);
    mkdirSync(dir, { recursive: true });
    stored.pages.forEach((page, i) =>
      writeFileSync(
        join(dir, `page-${String(i + 1).padStart(3, "0")}.jpg`),
        page,
      ),
    );
    stored.thumbs?.forEach((thumb, i) => {
      if (thumb) writeFileSync(join(dir, thumbFileName(i, thumb)), thumb);
    });
    writeFileSync(join(dir, "scan.pdf"), stored.pdf);
  });
  writeFileSync(
    pendingJson(staging),
    JSON.stringify({ parts: parts.map((p) => p.part) }),
  );
  rmSync(pendingDir(stateDir), { recursive: true, force: true });
  renameSync(staging, pendingDir(stateDir));
}

export const clearPending = (stateDir: string): void =>
  rmSync(pendingDir(stateDir), { recursive: true, force: true });

// What a running scan reports (`--status` shows it while the scan lock is held).
export interface Progress {
  mode: string;
  page: number;
  startedAt: number;
  pid: number;
}
const progressPath = (stateDir: string): string =>
  join(stateDir, "progress.json");

export function writeProgress(stateDir: string, progress: Progress): void {
  try {
    writeFileSync(progressPath(stateDir), JSON.stringify(progress));
  } catch {
    // progress is a courtesy: a scan never fails on it
  }
}

export function readProgress(stateDir: string): Progress | null {
  try {
    const v = JSON.parse(readFileSync(progressPath(stateDir), "utf8"));
    return typeof v?.mode === "string" &&
      Number.isInteger(v.page) &&
      typeof v.startedAt === "number" &&
      Number.isInteger(v.pid)
      ? { mode: v.mode, page: v.page, startedAt: v.startedAt, pid: v.pid }
      : null;
  } catch {
    return null;
  }
}

export const clearProgress = (stateDir: string): void =>
  rmSync(progressPath(stateDir), { force: true });

export interface PendingLockDeps {
  pid: number;
  isPidAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

const LOCK_ATTEMPTS = 400;
const LOCK_RETRY_MS = 50;

function readLockPid(path: string): number | null {
  try {
    const pid = parseInt(readFileSync(path, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Runs `fn` with the pending lock. A lock whose process is gone is taken over.
export async function withPendingLock<T>(
  stateDir: string,
  deps: PendingLockDeps,
  fn: () => Promise<T> | T,
): Promise<T> {
  const path = pendingLockPath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, String(deps.pid), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLockPid(path);
      const alive =
        holder !== null && (holder === deps.pid || deps.isPidAlive(holder));
      if (!alive) {
        rmSync(path, { force: true });
        continue;
      }
      if (attempt >= LOCK_ATTEMPTS) {
        throw new Error("The pending scan is busy, try again");
      }
      await deps.sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}

const DISCARDED_KEEP = 5;

// Moves the PDFs of the pending scan to `discarded/<fileName>` (never
// overwriting) and keeps only the newest five files there.
export function discardPendingFiles(
  stateDir: string,
  pending: Pending,
): string[] {
  const dir = join(stateDir, "discarded");
  mkdirSync(dir, { recursive: true });
  const targets = pending.parts.map((part, index) => {
    let target = join(dir, part.fileName);
    for (let n = 2; exists(target); n++) {
      target = join(dir, part.fileName.replace(/\.pdf$/, `-${n}.pdf`));
    }
    copyFileSync(partPdfPath(stateDir, index), target);
    return target;
  });
  clearPending(stateDir);
  const files = readdirSync(dir)
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  for (const old of files.slice(DISCARDED_KEEP)) {
    rmSync(join(dir, old.name), { force: true });
  }
  return targets;
}

const exists = (path: string): boolean => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};
