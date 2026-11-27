// The CUPS adapter: the only code that runs `lp`, `cancel`, `lpstat` and
// `ipptool`. Every process goes through the injected `exec` port, so tests use a
// fake and nothing here can print. Reads are IPP (`ipptool -tv`) and the one
// `lp` answer; see parse.ts for why the human text is never parsed.
//
// Real submission and cancellation are the owner's to run (`--dry-run`,
// `--check`, `--status`, or `--hold` then `--cancel`), never a test's.

import { Check, fail, lpArgs, ok, PrintRequest } from "./options";
import {
  ACTIVE_JOB_STATES,
  parseDefaultDestination,
  parseIpp,
  parseJobs,
  parsePrinterStatus,
  parseRequestId,
  PrinterStatus,
  PrintJob,
  splitJobId,
} from "./parse";

export interface ExecResult {
  code: number; // -1 when the tool could not start
  stdout: string;
  stderr: string;
}

export interface CupsPorts {
  // Runs a CUPS tool with LC_ALL=C; never rejects.
  exec(file: string, args: string[], timeoutMs: number): Promise<ExecResult>;
  // A temporary ipptool test file holding `text`; `remove` deletes it.
  tempFile(text: string): { path: string; remove(): void };
  user: string;
  now(): number; // ms
  sleep(ms: number): Promise<void>;
}

export interface CheckedPrinter {
  printer: string;
  status: PrinterStatus;
  queued: number;
}

const LOCAL = "ipp://localhost";
const LIST_TIMEOUT_MS = 20_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const CANCEL_TIMEOUT_MS = 20_000;
const POLL_MS = 1000;
const TERMINAL_STATES: readonly string[] = ["canceled", "aborted", "completed"];

const JOB_FIELDS =
  "job-id,job-state,job-state-reasons,job-name,job-originating-user-name,time-at-creation,job-media-sheets-completed";

// One ipptool test: the operation attributes are the only thing that varies.
function ippTest(
  name: string,
  operation: string,
  attributes: string[],
): string {
  return [
    "{",
    `    NAME "${name}"`,
    `    OPERATION ${operation}`,
    "    GROUP operation-attributes-tag",
    "    ATTR charset attributes-charset utf-8",
    "    ATTR language attributes-natural-language en",
    ...attributes.map((attribute) => `    ${attribute}`),
    "    STATUS successful-ok",
    "}",
    "",
  ].join("\n");
}

const PRINTER_TEST = ippTest(
  "Get printer attributes",
  "Get-Printer-Attributes",
  [
    "ATTR uri printer-uri $uri",
    "ATTR keyword requested-attributes printer-name,printer-state,printer-state-reasons,printer-is-accepting-jobs,marker-types,marker-levels,marker-low-levels",
  ],
);

const jobsTest = (user: string): string =>
  ippTest("Get jobs", "Get-Jobs", [
    "ATTR uri printer-uri $uri",
    "ATTR keyword which-jobs not-completed",
    `ATTR name requesting-user-name ${user.replace(/[^\w.-]/g, "")}`,
    `ATTR keyword requested-attributes ${JOB_FIELDS}`,
  ]);

const JOB_TEST = ippTest("Get job attributes", "Get-Job-Attributes", [
  "ATTR uri job-uri $uri",
  `ATTR keyword requested-attributes ${JOB_FIELDS}`,
]);

export function createCups(ports: CupsPorts) {
  // The raw `ipptool -tv` text: the parsers read it, the status line included.
  async function ipp(test: string, uri: string): Promise<string> {
    const file = ports.tempFile(test);
    try {
      const result = await ports.exec(
        "ipptool",
        ["-tv", uri, file.path],
        LIST_TIMEOUT_MS,
      );
      return result.stdout;
    } finally {
      file.remove();
    }
  }

  // The queue to use: the one asked for, else the system default.
  async function resolvePrinter(requested?: string): Promise<string | null> {
    if (requested) return requested;
    const result = await ports.exec("lpstat", ["-d"], LIST_TIMEOUT_MS);
    return parseDefaultDestination(result.stdout);
  }

  async function printerStatus(printer: string): Promise<Check<PrinterStatus>> {
    const text = await ipp(PRINTER_TEST, `${LOCAL}/printers/${printer}`);
    const { statusCode } = parseIpp(text);
    if (statusCode === "client-error-not-found") {
      return fail(`No printer named "${printer}"`);
    }
    const status = parsePrinterStatus(text);
    if (!status) {
      return fail(
        `Printer "${printer}" did not report its state (${statusCode ?? "no answer"})`,
      );
    }
    return ok(status);
  }

  // The queue's active jobs (every user's; cancel filters to the current one).
  async function jobs(printer: string): Promise<Check<PrintJob[]>> {
    const text = await ipp(
      jobsTest(ports.user),
      `${LOCAL}/printers/${printer}`,
    );
    if (parseIpp(text).statusCode !== "successful-ok") {
      return fail(`Could not list the jobs of "${printer}"`);
    }
    return ok(
      parseJobs(text, printer).filter((job) =>
        ACTIVE_JOB_STATES.includes(job.state),
      ),
    );
  }

  async function job(id: string): Promise<Check<PrintJob>> {
    const parts = splitJobId(id);
    if (!parts) return fail(`Not a job id: ${id}`);
    const text = await ipp(JOB_TEST, `${LOCAL}/jobs/${parts.number}`);
    const found =
      parseIpp(text).statusCode === "successful-ok"
        ? parseJobs(text, parts.printer)[0]
        : undefined;
    return found ? ok(found) : fail(`No print job ${id}`);
  }

  // A queue that exists and takes jobs, with its active job count. Every
  // refusal names the reason in one line.
  async function check(requested?: string): Promise<Check<CheckedPrinter>> {
    const printer = await resolvePrinter(requested);
    if (!printer) {
      return fail(
        "No default printer: pass --printer, or set printQueue in the extension preferences",
      );
    }
    const status = await printerStatus(printer);
    if (!status.ok) return status;
    if (!status.value.accepting) {
      return fail(`Printer "${printer}" is not accepting jobs`);
    }
    if (status.value.state === "stopped") {
      return fail(`Printer "${printer}" is stopped`);
    }
    const queued = await jobs(printer);
    if (!queued.ok) return queued;
    return ok({ printer, status: status.value, queued: queued.value.length });
  }

  async function submit(
    request: PrintRequest & { printer: string },
  ): Promise<Check<string>> {
    const result = await ports.exec("lp", lpArgs(request), SUBMIT_TIMEOUT_MS);
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n")[0];
      return fail(`lp did not accept the file${detail ? `: ${detail}` : ""}`);
    }
    const id = parseRequestId(result.stdout, request.printer);
    return id ? ok(id) : fail("CUPS did not return a job id");
  }

  async function cancel(id: string): Promise<Check<string>> {
    const result = await ports.exec("cancel", [id], CANCEL_TIMEOUT_MS);
    return result.code === 0 ? ok(id) : fail(`Could not cancel ${id}`);
  }

  // Only the current user's active jobs on the queue.
  async function cancelAll(requested?: string): Promise<Check<string[]>> {
    const printer = await resolvePrinter(requested);
    if (!printer) return fail("No default printer to cancel jobs on");
    const active = await jobs(printer);
    if (!active.ok) return active;
    const mine = active.value.filter((j) => j.user === ports.user);
    const cancelled: string[] = [];
    for (const { id } of mine) {
      const result = await cancel(id);
      if (!result.ok) {
        return fail(
          `${result.message} (cancelled ${cancelled.length} of ${mine.length})`,
        );
      }
      cancelled.push(id);
    }
    return ok(cancelled);
  }

  // Polls the job until it ends or the time runs out. A timeout is not a
  // failure: the job is still queued, and the caller reports the state.
  async function waitFor(
    id: string,
    timeoutMs: number,
  ): Promise<Check<{ job: PrintJob; timedOut: boolean }>> {
    const started = ports.now();
    for (;;) {
      const current = await job(id);
      if (!current.ok) return current;
      if (TERMINAL_STATES.includes(current.value.state)) {
        return ok({ job: current.value, timedOut: false });
      }
      if (ports.now() - started >= timeoutMs) {
        return ok({ job: current.value, timedOut: true });
      }
      await ports.sleep(POLL_MS);
    }
  }

  return {
    resolvePrinter,
    printerStatus,
    jobs,
    job,
    check,
    submit,
    cancel,
    cancelAll,
    waitFor,
  };
}

export type Cups = ReturnType<typeof createCups>;
