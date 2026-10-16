// The Van Power state on disk, shared by two processes: the launchd sampler
// (scripts/van-sampler.ts, bun) and the Tinycast view. One directory, small
// JSON files, each rewritten whole through tmp + rename so the other process
// never reads a half-written file. The daemon owns `sampler.json`; the view
// owns the `paused` flag; both append samples to `van-history.json` and
// top up `victron-history.json` (read-modify-write, last rename wins).
// Pure fs, no `@raycast/api`, and only fs functions Tinycast's node shim
// implements (lib/tinycast-runtime.test.ts) — so the view reads it directly and
// vitest runs it against a tmp dir (VAN_SAMPLER_DIR).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

export const DEFAULT_VAN_DIR = join(homedir(), ".local/state/van-sampler");

export const SAMPLER_FILE = "sampler.json";
export const HISTORY_FILE = "van-history.json";
export const VICTRON_HISTORY_FILE = "victron-history.json";
export const PAUSED_FILE = "paused";

// Read per call, not at import: tests (and the smoke run) point it at a tmp dir.
export function vanDir(): string {
  return process.env?.VAN_SAMPLER_DIR || DEFAULT_VAN_DIR;
}

// null for a missing or unparsable file — callers validate the shape and fall
// back to their initial value.
export function readStoreJson(name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(vanDir(), name), "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(name: string, content: string): void {
  const dir = vanDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function writeStoreJson(name: string, value: unknown): void {
  writeAtomic(name, JSON.stringify(value));
}

export function hasStoreFile(name: string): boolean {
  return existsSync(join(vanDir(), name));
}

export function removeStoreFile(name: string): void {
  rmSync(join(vanDir(), name), { force: true });
}

// A flag is a file whose existence is the value.
export function setStoreFlag(name: string, on: boolean): void {
  if (on) writeAtomic(name, String(Date.now()));
  else removeStoreFile(name);
}
