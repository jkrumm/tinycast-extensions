// The print CLI's behaviour: argument parsing, the flow of each mode, and the
// one-line JSON contract. Pure orchestration over the injected `Cups` and file
// checks; `extension/scripts/print.ts` wires the real ones.
//
//   <file> [--pages 1-3,5] [--copies N] [--simplex | --short-edge] [--n-up N]
//          [--quality draft|normal|high] [--media A4] [--manual-feed] [--printer Q]
//          [--hold] [--wait [seconds]] [--dry-run]
//   --check [--printer Q]          the queue is idle enough to take a job
//   --status [<jobId>]            printer state, toner and active jobs (or one job)
//   --cancel <jobId>              cancel one job
//   --cancel-all [--printer Q]    cancel the current user's active jobs on the queue
//   --help
//
// Output is ONE JSON line with `ok`; exit 0 on ok, 1 on a failure, 2 on a usage
// error. --help is plain text. Nothing is submitted without a passing check.

import { basename } from "path";
import { Cups } from "./cups";
import {
  buildRequest,
  checkFile,
  Check,
  fail,
  lpArgs,
  ok,
  PrintInput,
  PrintRequest,
  sidesLabel,
  Sides,
} from "./options";
import { PrinterStatus } from "./parse";

export interface CliDeps {
  cups: Cups;
  stat(path: string): { isFile: boolean } | null;
  resolve(path: string): string;
}

export interface CliOutput {
  code: 0 | 1 | 2;
  text: string;
}

export const DEFAULT_WAIT_SECONDS = 300;

export type Command =
  | { kind: "help" }
  | { kind: "check"; printer?: string }
  | { kind: "status"; printer?: string; jobId?: string }
  | { kind: "cancel"; jobId: string }
  | { kind: "cancel-all"; printer?: string }
  | { kind: "print"; input: PrintInput; wait?: number; dryRun: boolean };

type Reply = { ok: boolean; message?: string } & Record<string, unknown>;

const BOOLEAN_FLAGS = new Set([
  "help",
  "check",
  "cancel-all",
  "simplex",
  "short-edge",
  "manual-feed",
  "hold",
  "dry-run",
]);
const VALUE_FLAGS = new Set([
  "pages",
  "copies",
  "n-up",
  "quality",
  "media",
  "printer",
  "cancel",
]);
// The value is optional: `--status` alone, `--wait` alone (300 s).
const OPTIONAL_FLAGS = new Set(["status", "wait"]);

type Flags = Map<string, string | true>;

function readFlags(argv: string[]): Check<{ flags: Flags; files: string[] }> {
  const flags: Flags = new Map();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      files.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      if (!hasValue) return fail(`--${name} needs a value`);
      flags.set(name, next);
      i++;
    } else if (OPTIONAL_FLAGS.has(name)) {
      const takesNumber = name === "status" || /^\d+$/.test(next ?? "");
      if (hasValue && takesNumber) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      return fail(`Unknown option --${name} (see --help)`);
    }
  }
  return ok({ flags, files });
}

const text = (flags: Flags, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};

const number = (flags: Flags, name: string): number | undefined => {
  const value = text(flags, name);
  return value === undefined ? undefined : Number(value);
};

export function parseCommand(argv: string[]): Check<Command> {
  const read = readFlags(argv);
  if (!read.ok) return read;
  const { flags, files } = read.value;
  if (flags.has("help")) return ok({ kind: "help" });

  const printer = text(flags, "printer");
  const modes = ["check", "status", "cancel", "cancel-all"].filter((m) =>
    flags.has(m),
  );
  if (files.length > 0) modes.push("print");
  if (modes.length === 0) {
    return fail(
      "Nothing to do: give a file to print, or --check, --status, --cancel <jobId> or --cancel-all (see --help)",
    );
  }
  if (modes.length > 1) {
    return fail(`Choose one of: ${modes.join(", ")}`);
  }

  if (modes[0] === "check") return ok({ kind: "check", printer });
  if (modes[0] === "status") {
    return ok({ kind: "status", printer, jobId: text(flags, "status") });
  }
  if (modes[0] === "cancel") {
    const jobId = text(flags, "cancel");
    return jobId
      ? ok({ kind: "cancel", jobId })
      : fail("--cancel needs a job id");
  }
  if (modes[0] === "cancel-all") return ok({ kind: "cancel-all", printer });
  return parsePrint(files, flags, printer);
}

function parsePrint(
  files: string[],
  flags: Flags,
  printer: string | undefined,
): Check<Command> {
  if (files.length !== 1) return fail("Give exactly one file to print");
  if (flags.has("simplex") && flags.has("short-edge")) {
    return fail("Choose one of --simplex or --short-edge");
  }
  const sides: Sides | undefined = flags.has("simplex")
    ? "one-sided"
    : flags.has("short-edge")
      ? "two-sided-short-edge"
      : undefined;

  const waitFlag = flags.get("wait");
  const wait =
    waitFlag === undefined
      ? undefined
      : waitFlag === true
        ? DEFAULT_WAIT_SECONDS
        : Number(waitFlag);
  if (wait !== undefined && (!Number.isInteger(wait) || wait < 1)) {
    return fail("--wait takes whole seconds (1 or more)");
  }

  return ok({
    kind: "print",
    input: {
      file: files[0],
      printer,
      sides,
      pages: text(flags, "pages"),
      copies: number(flags, "copies"),
      nUp: number(flags, "n-up"),
      quality: text(flags, "quality"),
      manualFeed: flags.has("manual-feed"),
      media: text(flags, "media"),
      hold: flags.has("hold"),
    },
    wait,
    dryRun: flags.has("dry-run"),
  });
}

export const HELP = `print-cli: print a file on the Mac's printer through CUPS (one JSON line out)

  print-cli <file> [options]     submit one file
    --pages 1-3,5,8-            page list (ascending not required)
    --copies N                  1-99 (default 1)
    --simplex                   one-sided (default: two-sided, long edge)
    --short-edge                two-sided, short edge
    --n-up N                    1, 2, 4, 6, 9 or 16 pages per sheet
    --quality draft|normal|high
    --media A4|A5|A6|Letter|Legal   (default A4)
    --manual-feed               feed from the manual tray
    --printer <queue>           default: the system default printer
    --hold                      hold the job until released (then --cancel it)
    --wait [seconds]            wait for the end of the job (default 300)
    --dry-run                   check, then print the lp argv; submits nothing
  print-cli --check [--printer <queue>]
  print-cli --status [<jobId>] [--printer <queue>]
  print-cli --cancel <jobId>
  print-cli --cancel-all [--printer <queue>]
  print-cli --help
`;

const usage = (message: string): CliOutput => ({
  code: 2,
  text: JSON.stringify({ ok: false, message }),
});

const reply = (value: Reply): CliOutput => ({
  code: value.ok ? 0 : 1,
  text: JSON.stringify(value),
});

const failure = (message: string): CliOutput => reply({ ok: false, message });

export async function runPrintCli(
  argv: string[],
  deps: CliDeps,
): Promise<CliOutput> {
  const parsed = parseCommand(argv);
  if (!parsed.ok) return usage(parsed.message);
  const command = parsed.value;
  switch (command.kind) {
    case "help":
      return { code: 0, text: HELP };
    case "check":
      return reply(await checkReply(deps.cups, command.printer));
    case "status":
      return reply(
        await statusReply(deps.cups, command.printer, command.jobId),
      );
    case "cancel":
      return reply(await cancelReply(deps.cups, command.jobId));
    case "cancel-all":
      return reply(await cancelAllReply(deps.cups, command.printer));
    case "print":
      return printOutput(deps, command.input, command.wait, command.dryRun);
  }
}

// Toner and other printer warnings: informational, never a refusal.
export function warningsOf(status: PrinterStatus): string[] {
  const warnings = status.tonerLow
    ? [
        status.tonerPercent !== null
          ? `Toner low (${status.tonerPercent} %)`
          : "Toner low",
      ]
    : [];
  for (const reason of status.reasons) {
    if (!reason.startsWith("toner-low"))
      warnings.push(`Printer reports ${reason}`);
  }
  return warnings;
}

async function checkReply(cups: Cups, printer?: string): Promise<Reply> {
  const checked = await cups.check(printer);
  if (!checked.ok) return { ok: false, message: checked.message };
  const { status, queued } = checked.value;
  return {
    ok: true,
    printer: checked.value.printer,
    state: status.state,
    accepting: status.accepting,
    reasons: status.reasons,
    tonerPercent: status.tonerPercent,
    tonerLow: status.tonerLow,
    queued,
    warnings: warningsOf(status),
  };
}

async function statusReply(
  cups: Cups,
  printer?: string,
  jobId?: string,
): Promise<Reply> {
  if (jobId) {
    const job = await cups.job(jobId);
    return job.ok
      ? { ok: true, job: job.value }
      : { ok: false, message: job.message };
  }
  const resolved = await cups.resolvePrinter(printer);
  if (!resolved) return { ok: false, message: "No default printer" };
  const status = await cups.printerStatus(resolved);
  if (!status.ok) return { ok: false, message: status.message };
  const jobs = await cups.jobs(resolved);
  if (!jobs.ok) return { ok: false, message: jobs.message };
  return {
    ok: true,
    printer: resolved,
    state: status.value.state,
    accepting: status.value.accepting,
    reasons: status.value.reasons,
    tonerPercent: status.value.tonerPercent,
    tonerLow: status.value.tonerLow,
    warnings: warningsOf(status.value),
    jobs: jobs.value,
  };
}

async function cancelReply(cups: Cups, jobId: string): Promise<Reply> {
  const cancelled = await cups.cancel(jobId);
  return cancelled.ok
    ? { ok: true, cancelled: [jobId], message: `Cancelled ${jobId}` }
    : { ok: false, message: cancelled.message };
}

async function cancelAllReply(cups: Cups, printer?: string): Promise<Reply> {
  const cancelled = await cups.cancelAll(printer);
  if (!cancelled.ok) return { ok: false, message: cancelled.message };
  const count = cancelled.value.length;
  return {
    ok: true,
    cancelled: cancelled.value,
    message:
      count === 0
        ? "No print jobs to cancel"
        : `Cancelled ${count} print job${count === 1 ? "" : "s"}`,
  };
}

// "two-sided; pages 1-3,5; 2 copies": what the message says about a job.
function describe(request: PrintRequest): string {
  return [
    sidesLabel(request.sides),
    request.pages ? `pages ${request.pages}` : null,
    request.copies > 1 ? `${request.copies} copies` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

async function printOutput(
  deps: CliDeps,
  input: PrintInput,
  wait: number | undefined,
  dryRun: boolean,
): Promise<CliOutput> {
  const built = buildRequest(input);
  if (!built.ok) return usage(built.message);
  const file = checkFile(deps.resolve(input.file), deps.stat);
  if (!file.ok) return failure(file.message);

  const checked = await deps.cups.check(input.printer);
  if (!checked.ok) return failure(checked.message);
  const printer = checked.value.printer;
  const warnings = warningsOf(checked.value.status);
  const request = { ...built.value, file: file.value, printer };
  const name = basename(file.value);

  if (dryRun) {
    return reply({
      ok: true,
      action: "dry-run",
      printer,
      file: file.value,
      argv: ["lp", ...lpArgs(request)],
      warnings,
    });
  }

  const submitted = await deps.cups.submit(request);
  if (!submitted.ok) return failure(submitted.message);
  const base = {
    action: "print",
    jobId: submitted.value,
    printer,
    file: file.value,
    sides: request.sides,
    pages: request.pages ?? null,
    copies: request.copies,
    warnings,
  };
  const label = `Printing ${name} (${describe(request)})`;
  if (wait === undefined) {
    return reply({ ok: true, ...base, message: label });
  }

  const waited = await deps.cups.waitFor(submitted.value, wait * 1000);
  if (!waited.ok) {
    return reply({ ok: false, ...base, message: waited.message });
  }
  const { job, timedOut } = waited.value;
  const state = job.state;
  if (timedOut) {
    return reply({
      ok: true,
      ...base,
      state,
      message: `Still ${state} after ${wait} s (${describe(request)})`,
    });
  }
  if (state === "completed") {
    return reply({
      ok: true,
      ...base,
      state,
      message: `Printed ${name} (${describe(request)})`,
    });
  }
  const why = job.reasons.length ? ` (${job.reasons.join(", ")})` : "";
  return reply({
    ok: false,
    ...base,
    state,
    message: `Print job ${submitted.value} ${state === "canceled" ? "was cancelled" : `ended ${state}`}${why}`,
  });
}
