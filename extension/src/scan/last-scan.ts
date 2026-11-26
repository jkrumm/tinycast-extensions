// The state "Scan More" continues from, in the state dir: `last-scan.json`
// (what was delivered to the inbox) and `last-pages/` (its page JPEGs,
// page-001.jpg …). Replaced by every newly delivered scan; a scan that went to
// partial/, blank/ or unsent/ never touches them. Plain sync fs.

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { LastScan, parseLastScan } from "./continue";

export const lastScanPath = (stateDir: string): string =>
  join(stateDir, "last-scan.json");
export const lastPagesDir = (stateDir: string): string =>
  join(stateDir, "last-pages");

const pageName = (index: number): string =>
  `page-${String(index + 1).padStart(3, "0")}.jpg`;

export function readLastScan(stateDir: string): LastScan | null {
  try {
    return parseLastScan(
      JSON.parse(readFileSync(lastScanPath(stateDir), "utf8")),
    );
  } catch {
    return null;
  }
}

// The kept page files, in page order.
export function listLastPages(stateDir: string): string[] {
  try {
    return readdirSync(lastPagesDir(stateDir))
      .filter((name) => /^page-\d+\.jpg$/.test(name))
      .sort()
      .map((name) => join(lastPagesDir(stateDir), name));
  } catch {
    return [];
  }
}

export const readLastPages = (stateDir: string): Uint8Array[] =>
  listLastPages(stateDir).map((path) => new Uint8Array(readFileSync(path)));

// Keeps `pageFiles` (the new scan's JPEGs) as the pages of `last`: after the
// existing ones (`append`) or instead of them (`replace`).
export function saveLastScan(
  stateDir: string,
  opts: {
    last: LastScan;
    pageFiles: string[];
    keepPages: "append" | "replace";
  },
): void {
  const dir = lastPagesDir(stateDir);
  if (opts.keepPages === "replace")
    rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const offset =
    opts.keepPages === "append" ? listLastPages(stateDir).length : 0;
  opts.pageFiles.forEach((file, i) =>
    copyFileSync(file, join(dir, pageName(offset + i))),
  );
  writeFileSync(lastScanPath(stateDir), JSON.stringify(opts.last));
}
