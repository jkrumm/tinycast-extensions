// What a scan job is given and what it answers, with the small helpers its
// parts share (the scan lock, the fronts file, messages). Split from `job.ts`
// so `filing.ts` can use them without a cycle.

import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { DeliverFs } from "./deliver";
import { ScanMode } from "./escl";
import { ScanHttp } from "./runner";

export interface JobOptions {
  mode: ScanMode;
  outDir: string;
  host?: string;
  stateDir: string;
  notify: boolean;
}

export interface JobDeps {
  http: ScanHttp;
  sleep(ms: number): Promise<void>;
  now(): number;
  pid: number;
  isPidAlive(pid: number): boolean;
  resolveHost(): Promise<string | null>;
  notify(opts: { title: string; body: string }): Promise<boolean>;
  deliverFs: DeliverFs;
  tmpRoot: string;
  // Ink share (0..1) of each page file, `null` where it could not be measured.
  measureInk(
    pagePaths: string[],
    log?: (line: string) => void,
  ): Promise<(number | null)[]>;
  // A thumbnail (JPEG bytes) of each page file, `null` where one failed.
  makeThumbs(
    pagePaths: string[],
    log?: (line: string) => void,
  ): Promise<(Uint8Array | null)[]>;
}

export type Failure = { ok: false; message: string };
export type JobResult = { ok: true; message: string } | Failure;

export const fail = (message: string): Failure => ({ ok: false, message });

export const pagesText = (n: number): string =>
  `${n} page${n === 1 ? "" : "s"}`;

// `/Users/me/.local/state/scan` → `~/.local/state/scan`.
export function shownPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export const lockPath = (stateDir: string): string => join(stateDir, "lock");

export function readLockPid(stateDir: string): number | null {
  try {
    const pid = parseInt(readFileSync(lockPath(stateDir), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Is a scan (a process other than this one) running right now?
export function scanRunning(stateDir: string, deps: JobDeps): boolean {
  const holder = readLockPid(stateDir);
  return holder !== null && holder !== deps.pid && deps.isPidAlive(holder);
}

// The messages that already read as a sentence go out as they are.
export const failureBody = (message: string): string =>
  /^Scan(ned| stopped)/.test(message) ? message : `Scan failed: ${message}`;

// The inbox has to be a directory (a share that is not mounted is not).
export function inboxProblem(outDir: string): Failure | null {
  try {
    if (statSync(outDir).isDirectory()) return null;
  } catch {
    // fall through
  }
  return fail("Scan inbox not found (is the share mounted?)");
}
