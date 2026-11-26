// One scan job, start to finish: the checks, the scan lock, the scan, the PDF,
// the pending scan, the log and the notification. The CLI (`scripts/scan.ts`)
// only parses arguments; the Tinycast command only runs `checkJob` through it
// and spawns it. Everything outside the scanner and the plain state files is
// injected, so the tests drive the whole job against `fake-scanner.ts` and
// temp dirs.
//
// Where a finished scan goes:
//   complete batch    → `<stateDir>/pending/` and stays there, without expiry,
//                       until Submit Scan files it in the inbox (`filing.ts`)
//                       or Discard Scan drops it: nothing reaches the inbox on
//                       its own, because the feeder of this device stops
//                       mid-stack and the consumer once filed the rest
//   inbox unreachable → `<stateDir>/unsent/`  (a finished scan is never lost)
//   incomplete batch  → `<stateDir>/partial/` (never the inbox: the consumer
//                       would file a truncated document)
//   all pages blank   → `<stateDir>/blank/`

import {
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { copyFile, mkdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { postNotification } from "../lib/notify";
import { inkLogLine, isBlankBatch } from "./blank";
import { DeliverFs, keepPdf } from "./deliver";
import { fileScannerCache, resolveScannerHost, runDnsSd } from "./discover";
import { scanFileName, SCAN_DPI } from "./escl";
import { submitBeforeScan } from "./filing";
import { measureInk } from "./ink";
import { makeThumbs } from "./thumbs";
import {
  fail,
  failureBody,
  inboxProblem,
  JobDeps,
  JobOptions,
  JobResult,
  lockPath,
  pagesText,
  readLockPid,
  scanRunning,
  shownPath,
} from "./job-types";
import { appendScanLog } from "./log";
import { jpegsToPdf } from "./pdf";
import {
  clearProgress,
  readStoredParts,
  readPending,
  StoredPart,
  withPendingLock,
  writePending,
  writeProgress,
} from "./pending";
import {
  backsStem,
  moreMessage,
  Pending,
  PendingPart,
  scannedMessage,
  startDecision,
} from "./pending-rules";
import {
  checkScanner,
  CheckResult,
  runScan,
  ScanError,
  ScanPorts,
} from "./runner";
import { curlScanHttp } from "./transport";

export type { JobDeps, JobOptions, JobResult } from "./job-types";
export { shownPath } from "./job-types";
export { discardPending, scanStatus, submitNow } from "./filing";

// A lock whose pid is not alive is taken over.
function acquireLock(stateDir: string, deps: JobDeps): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath(stateDir), String(deps.pid), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (scanRunning(stateDir, deps)) return false;
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

// `--check`: every reason a scan would not start, no side effects.
export async function checkJob(
  opts: JobOptions,
  deps: JobDeps,
): Promise<CheckResult> {
  const problem = inboxProblem(opts.outDir);
  if (problem) return problem;
  const decision = startDecision(readPending(opts.stateDir), opts.mode);
  if (decision.kind === "refuse") return fail(decision.message);
  if (scanRunning(opts.stateDir, deps)) {
    return fail("A scan is already running");
  }
  const host = opts.host ?? (await deps.resolveHost());
  if (!host) return fail("Scanner not reachable");
  return checkScanner(scanPorts(opts, deps, ""), { host, mode: opts.mode });
}

const scanPagePath = (dir: string, index: number): string =>
  join(dir, `page-${String(index + 1).padStart(3, "0")}.jpg`);

const logFor =
  (opts: JobOptions, deps: JobDeps) =>
  (line: string): void =>
    appendScanLog(join(opts.stateDir, "scan.log"), line, new Date(deps.now()));

function scanPorts(
  opts: JobOptions,
  deps: JobDeps,
  tmpDir: string,
  startedAt = deps.now(),
): ScanPorts {
  return {
    http: deps.http,
    sleep: deps.sleep,
    now: deps.now,
    pagePath: (index) => scanPagePath(tmpDir, index),
    readFile: async (path) => new Uint8Array(readFileSync(path)),
    log: logFor(opts, deps),
    onPage: (page) =>
      writeProgress(opts.stateDir, {
        mode: opts.mode,
        page,
        startedAt,
        pid: deps.pid,
      }),
  };
}

export async function runJob(
  opts: JobOptions,
  deps: JobDeps,
): Promise<JobResult> {
  mkdirSync(opts.stateDir, { recursive: true });
  const log = logFor(opts, deps);
  log(`start mode=${opts.mode} out=${opts.outDir}`);

  let result: JobResult;
  let locked = false;
  try {
    locked = acquireLock(opts.stateDir, deps);
    result = locked
      ? await execute(opts, deps, log)
      : fail("A scan is already running");
  } catch (error) {
    if (!(error instanceof ScanError)) log(`error: ${String(error)}`);
    result = fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (locked) {
      clearProgress(opts.stateDir);
      releaseLock(opts.stateDir, deps);
    }
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

async function execute(
  opts: JobOptions,
  deps: JobDeps,
  log: (line: string) => void,
): Promise<JobResult> {
  const problem = inboxProblem(opts.outDir);
  if (problem) return problem;

  // What a pending scan means for this one: refused (no fronts, nothing to
  // continue), filed first, continued, or nothing.
  let pending = readPending(opts.stateDir);
  const decision = startDecision(pending, opts.mode);
  if (decision.kind === "refuse") return fail(decision.message);
  if (decision.kind === "submit-first") {
    await submitBeforeScan(opts, deps, log);
    pending = null;
  }

  const host = opts.host ?? (await deps.resolveHost());
  if (!host) return fail("Scanner not reachable");

  const tmp = mkdtempSync(join(deps.tmpRoot, "scan-"));
  // Pages exist from the first download on: from then on the temp dir is only
  // removed once the scan is safe somewhere (pending, partial, blank).
  let keepTmp = false;
  try {
    const startedAt = deps.now();
    writeProgress(opts.stateDir, {
      mode: opts.mode,
      page: 0,
      startedAt,
      pid: deps.pid,
    });
    const scan = await runScan(scanPorts(opts, deps, tmp, startedAt), {
      host,
      mode: opts.mode,
    });
    keepTmp = true;
    const count = scan.pages.length;
    log(
      `scanned ${pagesText(count)} in ${Math.round((deps.now() - startedAt) / 1000)} s`,
    );

    const pdf = jpegsToPdf(scan.pages.map((jpeg) => ({ jpeg, dpi: SCAN_DPI })));
    const pdfPath = join(tmp, "scan.pdf");
    writeFileSync(pdfPath, pdf);
    // The name a new part is filed under; partial and blank PDFs get it too.
    const plainName = scanFileName(
      opts.mode,
      new Date(deps.now()),
      opts.mode === "backs" && pending ? backsStem(pending) : undefined,
    );

    if (!scan.complete) {
      const dir = join(opts.stateDir, "partial");
      const kept = await keepPdf(deps.deliverFs, {
        src: pdfPath,
        dir,
        fileName: plainName,
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
          fileName: plainName,
        });
        keepTmp = false;
        log(`blank batch kept: ${kept}`);
        return fail(
          `Scan stopped: all ${count} pages look blank. Stack upside down? PDF kept in ${shownPath(dir)}`,
        );
      }
    }

    // Thumbnails for the Scanner view; a scan never fails on them.
    const thumbs = await deps
      .makeThumbs(
        scan.pages.map((_, i) => scanPagePath(tmp, i)),
        log,
      )
      .catch((error) => {
        log(`thumbs: failed: ${String(error)}`);
        return scan.pages.map(() => null);
      });

    const message = await withPendingLock(opts.stateDir, deps, () =>
      store(opts, {
        pages: scan.pages,
        thumbs,
        pdf,
        plainName,
        at: deps.now(),
      }),
    );
    keepTmp = false;
    return { ok: true, message };
  } finally {
    if (keepTmp) log(`temp dir kept: ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
}

// Makes the scan pending: a new one, the backs next to the pending fronts, or
// the pending scan's last part with the new pages appended. Under the pending
// lock; returns the message.
function store(
  opts: JobOptions,
  scan: {
    pages: Uint8Array[];
    thumbs: (Uint8Array | null)[];
    pdf: Uint8Array;
    plainName: string;
    at: number;
  },
): string {
  const stored = readStoredParts(opts.stateDir);
  const count = scan.pages.length;
  // Nothing else can touch the pending scan while a scan holds the scan lock.
  const changed = new ScanError("The pending scan changed during the scan");

  if (opts.mode === "more") {
    const last = stored[stored.length - 1];
    if (!last) throw changed;
    const pages = [...last.pages, ...scan.pages];
    const part: PendingPart = {
      ...last.part,
      pages: pages.length,
      at: scan.at,
    };
    const parts: StoredPart[] = [
      ...stored.slice(0, -1),
      {
        part,
        pages,
        thumbs: [
          ...(last.thumbs ?? last.pages.map(() => null)),
          ...scan.thumbs,
        ],
        pdf: jpegsToPdf(pages.map((jpeg) => ({ jpeg, dpi: SCAN_DPI }))),
      },
    ];
    writePending(opts.stateDir, parts);
    return moreMessage({
      newPages: count,
      total: pages.length,
      pending: { parts: parts.map((p) => p.part) },
    });
  }

  const part: PendingPart = {
    mode: opts.mode as PendingPart["mode"],
    fileName: scan.plainName,
    pages: count,
    at: scan.at,
  };
  const added: StoredPart = {
    part,
    pdf: scan.pdf,
    pages: scan.pages,
    thumbs: scan.thumbs,
  };
  let parts: StoredPart[] = [added];
  if (opts.mode === "backs") {
    if (stored.length !== 1 || stored[0].part.mode !== "fronts") throw changed;
    parts = [stored[0], added];
  }
  writePending(opts.stateDir, parts);
  const pending: Pending = { parts: parts.map((p) => p.part) };
  return scannedMessage({ mode: opts.mode, pages: count, pending });
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
    makeThumbs,
  };
}
