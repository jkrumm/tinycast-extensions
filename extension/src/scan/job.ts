// One scan job, start to finish: the checks, the lock, the scan, the PDF, the
// delivery, the state files, the log and the notification. The CLI
// (`scripts/scan.ts`) only parses arguments; the Tinycast command only runs
// `checkJob` through it and spawns it. Everything outside the scanner and the
// plain state files is injected, so the tests drive the whole job against
// `fake-scanner.ts` and temp dirs.
//
// Where a PDF ends up:
//   complete batch    → `--out-dir`, the inbox another automation picks up
//   inbox unreachable → `<stateDir>/unsent/`  (a finished scan is never lost)
//   incomplete batch  → `<stateDir>/partial/` (never the inbox: the consumer
//                       would file a truncated document)

import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { copyFile, mkdir, rm, stat } from "fs/promises";
import { homedir, tmpdir } from "os";
import { basename, join } from "path";
import { postNotification } from "../lib/notify";
import {
  CONSUMER_LOCK,
  checkContinuable,
  LastScan,
  moreResult,
  MorePlan,
  planMore,
} from "./continue";
import { DeliverFs, deliverPdf, keepPdf } from "./deliver";
import { fileScannerCache, resolveScannerHost, runDnsSd } from "./discover";
import { frontsStemOf, scanFileName, ScanMode, SCAN_DPI } from "./escl";
import { inkLogLine, isBlankBatch } from "./blank";
import { measureInk } from "./ink";
import {
  listLastPages,
  readLastPages,
  readLastScan,
  saveLastScan,
} from "./last-scan";
import { appendScanLog } from "./log";
import { jpegsToPdf } from "./pdf";
import {
  checkScanner,
  CheckResult,
  runScan,
  ScanError,
  ScanHttp,
  ScanPorts,
} from "./runner";
import { curlScanHttp } from "./transport";

export const FRONTS_MAX_AGE_MS = 30 * 60 * 1000;

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
}

type Failure = { ok: false; message: string };

export type JobResult = { ok: true; message: string } | Failure;

const lockPath = (stateDir: string): string => join(stateDir, "lock");
const frontsPath = (stateDir: string): string =>
  join(stateDir, "last-fronts.json");

const fail = (message: string): Failure => ({
  ok: false,
  message,
});

const pagesText = (n: number): string => `${n} page${n === 1 ? "" : "s"}`;

// `/Users/me/.local/state/scan` → `~/.local/state/scan`.
export function shownPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function readLockPid(stateDir: string): number | null {
  try {
    const pid = parseInt(readFileSync(lockPath(stateDir), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function lockHeldByOther(stateDir: string, deps: JobDeps): boolean {
  const holder = readLockPid(stateDir);
  return holder !== null && holder !== deps.pid && deps.isPidAlive(holder);
}

// A lock whose pid is not alive is taken over.
function acquireLock(stateDir: string, deps: JobDeps): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath(stateDir), String(deps.pid), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockHeldByOther(stateDir, deps)) return false;
      rmSync(lockPath(stateDir), { force: true });
    }
  }
  return false;
}

function releaseLock(stateDir: string, deps: JobDeps): void {
  if (readLockPid(stateDir) === deps.pid) {
    rmSync(lockPath(stateDir), { force: true });
  }
}

interface Fronts {
  stem: string;
  // The fronts page count; absent in a file written before it was recorded.
  pages?: number;
}

function readFronts(stateDir: string, nowMs: number): Fronts | null {
  try {
    const value = JSON.parse(readFileSync(frontsPath(stateDir), "utf8"));
    if (typeof value?.stem !== "string" || typeof value?.at !== "number") {
      return null;
    }
    if (nowMs - value.at >= FRONTS_MAX_AGE_MS) return null;
    return {
      stem: value.stem,
      pages: Number.isInteger(value.pages) ? value.pages : undefined,
    };
  } catch {
    return null;
  }
}

type Preflight = { ok: true; fronts?: Fronts; last?: LastScan } | Failure;

// Everything that does not need the scanner: the inbox exists, a backs scan
// has a fronts scan to pair with, a "more" scan has a scan to continue.
function preflight(opts: JobOptions, deps: JobDeps): Preflight {
  try {
    if (!statSync(opts.outDir).isDirectory())
      throw new Error("not a directory");
  } catch {
    return fail("Scan inbox not found (is the share mounted?)");
  }
  if (opts.mode === "more") {
    const next = checkContinuable(
      readLastScan(opts.stateDir),
      listLastPages(opts.stateDir).length,
      deps.now(),
    );
    return next.ok ? { ok: true, last: next.last } : fail(next.message);
  }
  if (opts.mode !== "backs") return { ok: true };
  const fronts = readFronts(opts.stateDir, deps.now());
  return fronts ? { ok: true, fronts } : fail("Scan the fronts first");
}

// `--check`: every reason a scan would not start, no side effects.
export async function checkJob(
  opts: JobOptions,
  deps: JobDeps,
): Promise<CheckResult> {
  const pre = preflight(opts, deps);
  if (!pre.ok) return pre;
  if (lockHeldByOther(opts.stateDir, deps)) {
    return fail("A scan is already running");
  }
  const host = opts.host ?? (await deps.resolveHost());
  if (!host) return fail("Scanner not reachable");
  return checkScanner(scanPorts(opts, deps, ""), { host, mode: opts.mode });
}

const scanPagePath = (dir: string, index: number): string =>
  join(dir, `page-${String(index + 1).padStart(3, "0")}.jpg`);

function scanPorts(opts: JobOptions, deps: JobDeps, tmpDir: string): ScanPorts {
  return {
    http: deps.http,
    sleep: deps.sleep,
    now: deps.now,
    pagePath: (index) => scanPagePath(tmpDir, index),
    readFile: async (path) => new Uint8Array(readFileSync(path)),
    log: (line) =>
      appendScanLog(
        join(opts.stateDir, "scan.log"),
        line,
        new Date(deps.now()),
      ),
  };
}

export async function runJob(
  opts: JobOptions,
  deps: JobDeps,
): Promise<JobResult> {
  mkdirSync(opts.stateDir, { recursive: true });
  const log = (line: string): void =>
    appendScanLog(join(opts.stateDir, "scan.log"), line, new Date(deps.now()));
  log(`start mode=${opts.mode} out=${opts.outDir}`);

  let result: JobResult;
  let locked = false;
  try {
    locked = acquireLock(opts.stateDir, deps);
    result = locked
      ? await execute(opts, deps, log)
      : fail("A scan is already running");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ScanError)) log(`error: ${String(error)}`);
    result = fail(message);
  } finally {
    if (locked) releaseLock(opts.stateDir, deps);
  }

  log(result.ok ? `done: ${result.message}` : `failed: ${result.message}`);
  if (opts.notify) {
    await deps.notify({
      title: "Scan",
      body: result.ok ? result.message : failureBody(result.message),
    });
  }
  return result;
}

// The messages that already read as a sentence ("Scan stopped…", "Scanned…")
// go out as they are.
const failureBody = (message: string): string =>
  /^Scan(ned| stopped)/.test(message) ? message : `Scan failed: ${message}`;

async function execute(
  opts: JobOptions,
  deps: JobDeps,
  log: (line: string) => void,
): Promise<JobResult> {
  const pre = preflight(opts, deps);
  if (!pre.ok) return pre;
  const host = opts.host ?? (await deps.resolveHost());
  if (!host) return fail("Scanner not reachable");

  const tmp = mkdtempSync(join(deps.tmpRoot, "scan-"));
  // Pages exist from the first download on: from then on the temp dir is only
  // removed once the PDF is verified somewhere (inbox, unsent or partial).
  let keepTmp = false;
  try {
    const startedAt = deps.now();
    const scan = await runScan(scanPorts(opts, deps, tmp), {
      host,
      mode: opts.mode,
    });
    keepTmp = true;
    const count = scan.pages.length;
    log(
      `scanned ${pagesText(count)} in ${Math.round((deps.now() - startedAt) / 1000)} s`,
    );

    const pdfPath = join(tmp, "scan.pdf");
    writeFileSync(
      pdfPath,
      jpegsToPdf(scan.pages.map((jpeg) => ({ jpeg, dpi: SCAN_DPI }))),
    );
    const fileName = scanFileName(
      opts.mode,
      new Date(deps.now()),
      pre.fronts?.stem,
    );

    if (!scan.complete) {
      const dir = join(opts.stateDir, "partial");
      const kept = await keepPdf(deps.deliverFs, {
        src: pdfPath,
        dir,
        fileName,
      });
      keepTmp = false;
      log(`partial kept: ${kept}`);
      return fail(
        `Scan stopped after ${pagesText(count)}: ${scan.reason}. Partial PDF kept in ${shownPath(dir)}`,
      );
    }

    // A stack that went in upside down scans as blank pages. Not for backs
    // (blank backs are normal) and not for the flatbed.
    if (
      opts.mode === "feeder" ||
      opts.mode === "fronts" ||
      opts.mode === "more"
    ) {
      const shares = await deps
        .measureInk(
          scan.pages.map((_, i) => scanPagePath(tmp, i)),
          log,
        )
        .catch((error) => {
          log(`ink: measuring failed: ${String(error)}`);
          return [] as (number | null)[];
        });
      if (shares.length > 0) log(inkLogLine(shares));
      if (isBlankBatch(shares)) {
        const dir = join(opts.stateDir, "blank");
        const kept = await keepPdf(deps.deliverFs, {
          src: pdfPath,
          dir,
          fileName,
        });
        keepTmp = false;
        log(`blank batch kept: ${kept}`);
        return fail(
          `Scan stopped: all ${count} pages look blank. Stack upside down? PDF kept in ${shownPath(dir)}`,
        );
      }
    }

    const keepDir = join(opts.stateDir, "unsent");
    const pageFiles = scan.pages.map((_, i) => scanPagePath(tmp, i));

    // "more" appends to the file still in the inbox, unless the consumer is
    // processing the inbox: one PDF of the kept and the new pages under the
    // same name (the old file is removed first, so the name is free again).
    let plan: MorePlan | null = null;
    let deliverSrc = pdfPath;
    let deliverName = fileName;
    if (opts.mode === "more" && pre.last) {
      plan = planMore({
        fileExists: existsSync(pre.last.path),
        lockExists: existsSync(join(opts.outDir, CONSUMER_LOCK)),
      });
      if (plan.kind === "append") {
        try {
          const combined = join(tmp, "combined.pdf");
          const all = [...readLastPages(opts.stateDir), ...scan.pages];
          writeFileSync(
            combined,
            jpegsToPdf(all.map((jpeg) => ({ jpeg, dpi: SCAN_DPI }))),
          );
          await deps.deliverFs.remove(pre.last.path);
          deliverSrc = combined;
          deliverName = pre.last.fileName;
        } catch (error) {
          log(`could not replace ${pre.last.path}: ${String(error)}`);
          plan = { kind: "separate", reason: "not-replaceable" };
        }
      }
    }

    const delivery = await deliverPdf(deps.deliverFs, {
      src: deliverSrc,
      outDir: opts.outDir,
      keepDir,
      fileName: deliverName,
    });
    keepTmp = false;

    // Fronts pair with the next backs scan as soon as the scan itself is done;
    // a backs scan only retires the pairing once its PDF reached the inbox.
    if (opts.mode === "fronts") {
      writeFileSync(
        frontsPath(opts.stateDir),
        JSON.stringify({
          stem: frontsStemOf(fileName),
          at: deps.now(),
          pages: count,
        }),
      );
    }
    if (delivery.kind === "kept") {
      const inFile =
        plan?.kind === "append" && pre.last ? pre.last.pages + count : count;
      log(`inbox copy failed (${delivery.error}); kept: ${delivery.path}`);
      return fail(
        `Scanned ${pagesText(inFile)} but the inbox is not reachable. PDF kept in ${shownPath(keepDir)}`,
      );
    }
    if (opts.mode === "backs")
      rmSync(frontsPath(opts.stateDir), { force: true });

    // What a later "more" continues from. Best effort: the scan is delivered.
    const keepState = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        log(`could not keep the last scan: ${String(error)}`);
      }
    };
    const deliveredName = basename(delivery.path);

    if (opts.mode === "more" && plan && pre.last) {
      const more = moreResult({
        plan,
        last: pre.last,
        newPages: count,
        deliveredPath: delivery.path,
        deliveredName,
        nowMs: deps.now(),
      });
      keepState(() => {
        saveLastScan(opts.stateDir, {
          last: more.lastScan,
          pageFiles,
          keepPages: more.keepPages,
        });
        if (more.frontsPages !== undefined) {
          setFrontsPages(opts.stateDir, more.frontsPages);
        }
      });
      return { ok: true, message: more.message };
    }

    const frontsPages = pre.fronts?.pages;
    keepState(() =>
      saveLastScan(opts.stateDir, {
        last: {
          mode: opts.mode,
          fileName: deliveredName,
          path: delivery.path,
          pages: count,
          at: deps.now(),
          frontsPages: opts.mode === "backs" ? frontsPages : undefined,
        },
        pageFiles,
        keepPages: "replace",
      }),
    );

    const delivered = `${pagesText(count)} -> ${deliveredName}`;
    if (opts.mode === "fronts") {
      return {
        ok: true,
        message: `${delivered}. Flip the stack, then Scan Backs`,
      };
    }
    if (
      opts.mode === "backs" &&
      frontsPages !== undefined &&
      frontsPages !== count
    ) {
      return { ok: true, message: `${delivered} (fronts had ${frontsPages})` };
    }
    return { ok: true, message: delivered };
  } finally {
    if (keepTmp) log(`temp dir kept: ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
}

// A continued fronts scan changes the fronts page count its backs pair with.
function setFrontsPages(stateDir: string, pages: number): void {
  if (!existsSync(frontsPath(stateDir))) return;
  const value = JSON.parse(readFileSync(frontsPath(stateDir), "utf8"));
  writeFileSync(frontsPath(stateDir), JSON.stringify({ ...value, pages }));
}

const nodeDeliverFs: DeliverFs = {
  copyExclusive: (src, dest) => copyFile(src, dest, constants.COPYFILE_EXCL),
  size: async (path) => (await stat(path)).size,
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  remove: (path) => rm(path, { force: true }),
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function systemJobDeps(stateDir: string): JobDeps {
  const cache = fileScannerCache(stateDir);
  return {
    http: curlScanHttp,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    pid: process.pid,
    isPidAlive: pidAlive,
    resolveHost: () =>
      resolveScannerHost({
        dnsSd: runDnsSd,
        reachable: async (host) =>
          (await curlScanHttp.get(`${host}/eSCL/ScannerStatus`, 3)).status !==
          0,
        ...cache,
        now: Date.now,
      }),
    notify: postNotification,
    deliverFs: nodeDeliverFs,
    tmpRoot: tmpdir(),
    measureInk,
  };
}
