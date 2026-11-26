// The eSCL scan itself, against injected ports so every rule is unit-tested
// with a fake device (and driven end to end against `fake-scanner.ts`; this
// code never talks to a real scanner from a test). The rules are the ones
// verified on the real device or taken from sane-airscan's Brother quirk
// table — AGENTS.md § Data sources (Scanner).

import {
  findJob,
  isFeederMode,
  jobUrl,
  parseScannerStatus,
  SCAN_DPI,
  scanSettingsXml,
  ScanMode,
  ScannerStatus,
  sourceFor,
} from "./escl";

export interface ScanHttp {
  get(url: string, timeoutS: number): Promise<{ status: number; body: string }>;
  post(
    url: string,
    contentType: string,
    body: string,
    timeoutS: number,
  ): Promise<{ status: number; location: string | null }>;
  download(
    url: string,
    destPath: string,
    timeoutS: number,
  ): Promise<{ status: number; ms: number }>;
  del(url: string): Promise<void>;
}

export interface ScanPorts {
  http: ScanHttp;
  sleep(ms: number): Promise<void>;
  now(): number;
  // Where the transport saves page `index` (0-based), and how to read it back.
  pagePath(index: number): string;
  readFile(path: string): Promise<Uint8Array>;
  log(line: string): void;
  // Called after every downloaded page with the number of pages so far.
  onPage?(pages: number): void;
}

export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanError";
  }
}

export type CheckResult = { ok: true } | { ok: false; message: string };

export interface ScanResult {
  pages: Uint8Array[];
  // false: the batch stopped early. The pages are still returned — the caller
  // keeps them but never files them as a finished document.
  complete: boolean;
  reason?: string;
}

// A scan run never lasts longer than this; the rest of an ADF batch is
// reported as incomplete ("timed out").
export const SCAN_DEADLINE_MS = 20 * 60 * 1000;

const STATUS_TIMEOUT_S = 8;
const PAGE_TIMEOUT_S = 120;
const POST_RETRIES = 10;
const PAGE_RETRIES = 30;
// A feeder that stalls and then goes on was seen live; 5 s was too short to outlast one.
export const BUSY_RETRIES = 60;
const RETRY_WAIT_MS = 1000;

interface ScanTarget {
  host: string;
  mode: ScanMode;
}

const statusUrl = (host: string): string => `${host}/eSCL/ScannerStatus`;

async function readStatus(ports: ScanPorts, host: string) {
  const res = await ports.http.get(statusUrl(host), STATUS_TIMEOUT_S);
  if (res.status !== 200) return null;
  return parseScannerStatus(res.body);
}

// The pre-flight of every scan: reachable, idle, paper in the feeder.
export async function checkScanner(
  ports: ScanPorts,
  { host, mode }: ScanTarget,
): Promise<CheckResult> {
  const status = await readStatus(ports, host);
  if (!status) return { ok: false, message: "Scanner not reachable" };
  if (status.state !== "Idle") return { ok: false, message: "Scanner is busy" };
  if (isFeederMode(mode) && status.adfState !== "ScannerAdfLoaded") {
    return { ok: false, message: "No document in the feeder" };
  }
  return { ok: true };
}

// What a feeder state other than "empty" means after the last page, in words.
export function adfProblem(adfState: string | null): string {
  switch (adfState) {
    case "ScannerAdfLoaded":
      return "paper still in the feeder";
    case "ScannerAdfJam":
      return "paper jam";
    case "ScannerAdfMispick":
      return "paper not picked up";
    case "ScannerAdfHatchOpen":
      return "feeder cover open";
    case null:
      return "scanner status unreadable";
    default:
      return `feeder state ${adfState}`;
  }
}

// The device cancels a job itself when the feeder does not pick up the paper
// (page requests then answer 410, the job record reads Canceled with
// JobCanceledAtDevice and no images).
export const FEEDER_CANCELLED =
  "the scanner cancelled the scan (the feeder did not pick up the paper)";
export const CANCELLED_TRY_AGAIN =
  "The scanner cancelled the scan (the feeder did not pick up the paper). Push the stack in and try again";

type Verdict =
  | { kind: "complete" }
  | { kind: "incomplete"; reason: string }
  | { kind: "running" };

const words = (code: string): string =>
  code.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

// After a 404 in a feeder mode, what the scanner's own record of OUR job says.
// The feeder state is not evidence: on the real device it reads "empty" from
// the 2nd second of a running job on. The running job is not listed at all;
// a finished one is, with the number of images it produced.
export function judgeBatch(
  status: ScannerStatus | null,
  job: string,
  received: number,
): Verdict {
  const record = status ? findJob(status, job) : null;
  if (record) {
    switch (record.state) {
      case "Completed":
        return record.imagesCompleted === null ||
          record.imagesCompleted === received
          ? { kind: "complete" }
          : {
              kind: "incomplete",
              reason: `scanner counted ${record.imagesCompleted} pages, received ${received}`,
            };
      case "Canceled":
      case "Aborted":
        return {
          kind: "incomplete",
          reason:
            record.reason === "JobCanceledAtDevice"
              ? FEEDER_CANCELLED
              : record.reason
                ? words(record.reason)
                : `job ${record.state.toLowerCase()}`,
        };
      case "Processing":
      case "Pending":
        return { kind: "running" };
      default:
        return {
          kind: "incomplete",
          reason: `job state ${record.state ?? "unknown"}`,
        };
    }
  }
  if (status?.state === "Processing") return { kind: "running" };
  // Not listed and idle (or unreadable): the feeder state is all there is.
  return status?.adfState === "ScannerAdfEmpty"
    ? { kind: "complete" }
    : { kind: "incomplete", reason: adfProblem(status?.adfState ?? null) };
}

async function createJob(
  ports: ScanPorts,
  { host, mode }: ScanTarget,
): Promise<string> {
  const settings = scanSettingsXml({
    source: sourceFor(mode),
    dpi: SCAN_DPI,
    color: "RGB24",
  });
  for (let attempt = 0; ; attempt++) {
    // `application/xml`, never `text/xml`: with text/xml this device silently
    // ignores resolution and region and returns a 200 dpi image.
    const res = await ports.http.post(
      `${host}/eSCL/ScanJobs`,
      "application/xml",
      settings,
      STATUS_TIMEOUT_S,
    );
    if (res.status === 503 && attempt < POST_RETRIES) {
      await ports.sleep(RETRY_WAIT_MS);
      continue;
    }
    if (res.status === 0) throw new ScanError("Scanner not reachable");
    if (res.status !== 201) {
      throw new ScanError(`Scanner refused the scan (HTTP ${res.status})`);
    }
    if (!res.location) throw new ScanError("Scanner returned no job location");
    return jobUrl(host, res.location);
  }
}

type PageRequest =
  | { kind: "page"; ms: number }
  | { kind: "end" }
  | { kind: "failed"; reason: string };

export async function runScan(
  ports: ScanPorts,
  target: ScanTarget,
): Promise<ScanResult> {
  const { host, mode } = target;
  const startedAt = ports.now();
  const remainingMs = (): number => startedAt + SCAN_DEADLINE_MS - ports.now();

  const check = await checkScanner(ports, target);
  if (!check.ok) throw new ScanError(check.message);

  const job = await createJob(ports, target);
  const pages: Uint8Array[] = [];

  const requestPage = async (): Promise<PageRequest> => {
    const n = pages.length + 1;
    for (let attempt = 0; ; attempt++) {
      if (remainingMs() <= 0) return { kind: "failed", reason: "timed out" };
      const timeoutS = Math.min(
        PAGE_TIMEOUT_S,
        Math.ceil(remainingMs() / 1000),
      );
      const res = await ports.http.download(
        `${job}/NextDocument`,
        ports.pagePath(pages.length),
        timeoutS,
      );
      if (res.status === 200) return { kind: "page", ms: res.ms };
      if (res.status === 404) return { kind: "end" };
      if (res.status === 503 && attempt < PAGE_RETRIES) {
        await ports.sleep(RETRY_WAIT_MS);
        continue;
      }
      ports.log(`page ${n}: HTTP ${res.status}`);
      if (res.status === 410)
        return { kind: "failed", reason: FEEDER_CANCELLED };
      const why =
        res.status === 0 ? "no answer from the scanner" : `HTTP ${res.status}`;
      return { kind: "failed", reason: `page ${n} failed (${why})` };
    }
  };

  let finalStatus: ScannerStatus | null | undefined;
  let outcome: { complete: boolean; reason?: string } = { complete: true };
  try {
    let previousMs: number | null = null;
    let busyRetries = 0;
    for (;;) {
      // The device answers 404 to an immediate next request while pages remain.
      if (previousMs !== null) {
        await ports.sleep(Math.min(RETRY_WAIT_MS, previousMs / 2));
      }
      const res = await requestPage();

      if (res.kind === "page") {
        const bytes = await ports.readFile(ports.pagePath(pages.length));
        pages.push(bytes);
        ports.log(`page ${pages.length}: ${bytes.length} bytes, ${res.ms} ms`);
        ports.onPage?.(pages.length);
        previousMs = res.ms;
        busyRetries = 0;
        if (!isFeederMode(mode)) break; // the flatbed holds one sheet
        continue;
      }

      if (res.kind === "failed") {
        outcome = { complete: false, reason: res.reason };
        break;
      }

      // 404: no more pages — or, in a feeder, the device being slow.
      if (!isFeederMode(mode)) break;
      if (pages.length === 0) break;
      finalStatus = await readStatus(ports, host).catch(() => null);
      const verdict = judgeBatch(finalStatus, job, pages.length);
      if (verdict.kind === "running") {
        if (busyRetries >= BUSY_RETRIES) {
          outcome = {
            complete: false,
            reason: "scanner still busy after the last page",
          };
          break;
        }
        busyRetries++;
        await ports.sleep(RETRY_WAIT_MS);
        previousMs = null;
        continue;
      }
      if (verdict.kind === "incomplete") {
        outcome = { complete: false, reason: verdict.reason };
      }
      break;
    }

    // Before the DELETE: the job record is what the log (and a failed page's
    // post-mortem) needs.
    if (isFeederMode(mode) && pages.length > 0) {
      if (finalStatus === undefined) {
        finalStatus = await readStatus(ports, host).catch(() => null);
      }
      const record = finalStatus ? findJob(finalStatus, job) : null;
      ports.log(
        `final: state=${finalStatus?.state ?? "unknown"} adf=${finalStatus?.adfState ?? "unknown"} job=${record?.state ?? "unlisted"} imagesCompleted=${record?.imagesCompleted ?? "n/a"} received=${pages.length}`,
      );
    }
  } catch (error) {
    // Pages already scanned are never thrown away with the error.
    if (pages.length === 0) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    outcome = { complete: false, reason };
    ports.log(`stopped: ${reason}`);
  } finally {
    // 404 is normal here: the job is already gone after completion.
    await ports.http.del(job).catch(() => undefined);
  }

  if (pages.length === 0) {
    if (outcome.reason === "timed out")
      throw new ScanError("The scan timed out");
    if (outcome.reason === FEEDER_CANCELLED)
      throw new ScanError(CANCELLED_TRY_AGAIN);
    throw new ScanError(outcome.reason ?? "The scanner returned no pages");
  }
  return { pages, ...outcome };
}
