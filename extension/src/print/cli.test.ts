import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_SECONDS,
  CliDeps,
  parseCommand,
  runPrintCli,
  warningsOf,
} from "./cli";
import {
  JOB_ONE,
  JOBS_HELD,
  JOBS_NONE,
  LPSTAT_DEFAULT_DE,
  PRINTER_IDLE,
  PRINTER_STOPPED,
} from "./fixtures";
import { fakeCups } from "./fake-cups";

const FILE = "/tmp/x.pdf";
const idle = {
  defaultDestination: LPSTAT_DEFAULT_DE,
  printer: () => PRINTER_IDLE,
  jobs: () => JOBS_NONE,
  job: () => JOB_ONE,
};

function deps(answers = idle) {
  const fake = fakeCups(answers);
  const cliDeps: CliDeps = {
    cups: fake.cups,
    stat: (path) => (path === FILE ? { isFile: true } : null),
    resolve: (path) => path,
  };
  return { cliDeps, calls: fake.calls };
}

const parsed = (argv: string[]) => {
  const result = parseCommand(argv);
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

const failureOf = (argv: string[]) => {
  const result = parseCommand(argv);
  return result.ok ? null : result.message;
};

describe("parseCommand", () => {
  it("asks for something to do", () => {
    expect(failureOf([])).toContain("Nothing to do");
  });

  it("refuses two modes at once", () => {
    expect(failureOf(["--check", "--status"])).toContain("Choose one of");
    expect(failureOf([FILE, "--check"])).toContain("Choose one of");
  });

  it("needs a value for a value flag", () => {
    expect(failureOf([FILE, "--pages"])).toBe("--pages needs a value");
  });

  it("rejects an unknown option", () => {
    expect(failureOf([FILE, "--colour"])).toContain("Unknown option --colour");
  });

  it("takes an optional job id after --status", () => {
    expect(parsed(["--status"])).toEqual({
      kind: "status",
      printer: undefined,
      jobId: undefined,
    });
    expect(parsed(["--status", "Example_Printer-26"])).toMatchObject({
      jobId: "Example_Printer-26",
    });
  });

  it("reads --wait with and without seconds", () => {
    expect(parsed([FILE, "--wait"])).toMatchObject({
      wait: DEFAULT_WAIT_SECONDS,
    });
    expect(parsed([FILE, "--wait", "60"])).toMatchObject({ wait: 60 });
    expect(failureOf([FILE, "--wait", "0"])).toContain(
      "--wait takes whole seconds",
    );
  });

  it("refuses --simplex with --short-edge", () => {
    expect(failureOf([FILE, "--simplex", "--short-edge"])).toContain("one of");
  });

  it("maps the sides flags", () => {
    expect(parsed([FILE, "--simplex"])).toMatchObject({
      input: { sides: "one-sided" },
    });
    expect(parsed([FILE, "--short-edge"])).toMatchObject({
      input: { sides: "two-sided-short-edge" },
    });
    expect(parsed([FILE])).toMatchObject({ input: { sides: undefined } });
  });

  it("wants exactly one file", () => {
    expect(failureOf([FILE, "/tmp/y.pdf"])).toBe(
      "Give exactly one file to print",
    );
  });
});

describe("runPrintCli", () => {
  it("prints the help text with exit 0", async () => {
    const { cliDeps } = deps();
    const out = await runPrintCli(["--help"], cliDeps);
    expect(out.code).toBe(0);
    expect(out.text).toContain("--dry-run");
  });

  it("answers a usage error with one JSON line and exit 2", async () => {
    const { cliDeps } = deps();
    const out = await runPrintCli([FILE, "--pages", "5-3"], cliDeps);
    expect(out.code).toBe(2);
    expect(JSON.parse(out.text)).toEqual({
      ok: false,
      message: 'Reversed page range "5-3"',
    });
  });

  it("dry-run prints the lp argv and submits nothing", async () => {
    const { cliDeps, calls } = deps();
    const out = await runPrintCli(
      [FILE, "--pages", "1-3,5", "--copies", "2", "--dry-run"],
      cliDeps,
    );
    expect(out.code).toBe(0);
    expect(JSON.parse(out.text)).toEqual({
      ok: true,
      action: "dry-run",
      printer: "Example_Printer",
      file: FILE,
      argv: [
        "lp",
        "-d",
        "Example_Printer",
        "-n",
        "2",
        "-o",
        "sides=two-sided-long-edge",
        "-o",
        "media=A4",
        "-o",
        "fit-to-page",
        "-P",
        "1-3,5",
        "-t",
        "x.pdf",
        "--",
        FILE,
      ],
      warnings: ["Toner low (10 %)"],
    });
    expect(calls.some((c) => c.file === "lp")).toBe(false);
  });

  it("submits a checked file and names the job", async () => {
    const { cliDeps, calls } = deps();
    const out = await runPrintCli(
      [FILE, "--pages", "1-3,5", "--copies", "2"],
      cliDeps,
    );
    const result = JSON.parse(out.text);
    expect(out.code).toBe(0);
    expect(result).toMatchObject({
      ok: true,
      action: "print",
      jobId: "Example_Printer-27",
      printer: "Example_Printer",
      pages: "1-3,5",
      copies: 2,
      sides: "two-sided-long-edge",
      message: "Printing x.pdf (two-sided; pages 1-3,5; 2 copies)",
    });
    expect(calls.filter((c) => c.file === "lp")).toHaveLength(1);
  });

  it("refuses a missing file before touching CUPS", async () => {
    const { cliDeps, calls } = deps();
    const out = await runPrintCli(["/nope/x.pdf"], cliDeps);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.text)).toEqual({
      ok: false,
      message: "No such file: /nope/x.pdf",
    });
    expect(calls).toEqual([]);
  });

  it("refuses to submit to a stopped queue and never runs lp", async () => {
    const { cliDeps, calls } = deps({
      ...idle,
      printer: () => PRINTER_STOPPED,
    });
    const out = await runPrintCli([FILE], cliDeps);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.text).ok).toBe(false);
    expect(calls.some((c) => c.file === "lp")).toBe(false);
  });

  it("reports a finished job with --wait", async () => {
    const { cliDeps } = deps();
    const out = await runPrintCli([FILE, "--wait", "5"], cliDeps);
    expect(JSON.parse(out.text)).toMatchObject({
      ok: true,
      state: "completed",
      message: "Printed x.pdf (two-sided)",
    });
  });

  it("reports a cancelled job as a failure with --wait", async () => {
    const cancelled = JOB_ONE.replace(
      "job-state (enum) = completed",
      "job-state (enum) = canceled",
    );
    const { cliDeps } = deps({ ...idle, job: () => cancelled });
    const out = await runPrintCli([FILE, "--wait", "5"], cliDeps);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.text)).toMatchObject({
      ok: false,
      state: "canceled",
      message:
        "Print job Example_Printer-27 was cancelled (processing-to-stop-point)",
    });
  });

  it("reports a still-running job after the wait as ok", async () => {
    const processing = JOB_ONE.replace(
      "job-state (enum) = completed",
      "job-state (enum) = processing",
    );
    const { cliDeps } = deps({ ...idle, job: () => processing });
    const out = await runPrintCli([FILE, "--wait", "2"], cliDeps);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.text)).toMatchObject({
      ok: true,
      state: "processing",
      message: "Still processing after 2 s (two-sided)",
    });
  });

  it("--check reports the queue and its warnings", async () => {
    const { cliDeps } = deps({ ...idle, jobs: () => JOBS_HELD });
    const out = await runPrintCli(["--check"], cliDeps);
    expect(JSON.parse(out.text)).toEqual({
      ok: true,
      printer: "Example_Printer",
      state: "idle",
      accepting: true,
      reasons: ["toner-low-warning"],
      tonerPercent: 10,
      tonerLow: true,
      queued: 1,
      warnings: ["Toner low (10 %)"],
    });
  });

  it("--status lists the active jobs without refusing a stopped queue", async () => {
    const { cliDeps } = deps({
      ...idle,
      printer: () => PRINTER_STOPPED,
      jobs: () => JOBS_HELD,
    });
    const result = JSON.parse((await runPrintCli(["--status"], cliDeps)).text);
    expect(result).toMatchObject({
      ok: true,
      state: "stopped",
      accepting: false,
    });
    expect(result.jobs).toEqual([
      expect.objectContaining({
        id: "Example_Printer-27",
        state: "pending-held",
      }),
    ]);
  });

  it("--cancel-all reports how many jobs it cancelled", async () => {
    const { cliDeps } = deps({ ...idle, jobs: () => JOBS_HELD });
    const out = await runPrintCli(["--cancel-all"], cliDeps);
    expect(JSON.parse(out.text)).toEqual({
      ok: true,
      cancelled: ["Example_Printer-27"],
      message: "Cancelled 1 print job",
    });
  });

  it("--cancel-all on an empty queue says so", async () => {
    const { cliDeps } = deps();
    const out = await runPrintCli(["--cancel-all"], cliDeps);
    expect(JSON.parse(out.text).message).toBe("No print jobs to cancel");
  });
});

describe("warningsOf", () => {
  it("lists the toner and other reasons, but not a quiet printer", () => {
    expect(
      warningsOf({
        state: "idle",
        accepting: true,
        reasons: ["toner-low-warning", "media-empty-warning"],
        tonerPercent: 10,
        tonerLow: true,
      }),
    ).toEqual(["Toner low (10 %)", "Printer reports media-empty-warning"]);
    expect(
      warningsOf({
        state: "idle",
        accepting: true,
        reasons: [],
        tonerPercent: 80,
        tonerLow: false,
      }),
    ).toEqual([]);
  });
});
