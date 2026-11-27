import { describe, expect, it } from "vitest";
import {
  JOB_ONE,
  JOBS_COMPLETED,
  JOBS_HELD,
  JOBS_NONE,
  LPSTAT_DEFAULT_DE,
  LPSTAT_DEFAULT_NONE,
  PRINTER_IDLE,
  PRINTER_NOT_FOUND,
  PRINTER_STOPPED,
} from "./fixtures";
import { fakeCups } from "./fake-cups";
import { PrintRequest } from "./options";

const idle = {
  defaultDestination: LPSTAT_DEFAULT_DE,
  printer: () => PRINTER_IDLE,
  jobs: () => JOBS_NONE,
  job: () => JOB_ONE,
};

describe("check", () => {
  it("passes an idle, accepting queue and resolves the default printer", async () => {
    const { cups } = fakeCups(idle);
    const result = await cups.check();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.printer).toBe("Example_Printer");
      expect(result.value.queued).toBe(0);
      expect(result.value.status.tonerLow).toBe(true);
    }
  });

  it("uses the requested queue without asking for the default", async () => {
    const { cups, calls } = fakeCups(idle);
    const result = await cups.check("Other_Queue");
    expect(result.ok && result.value.printer).toBe("Other_Queue");
    expect(calls.some((c) => c.file === "lpstat")).toBe(false);
  });

  it("refuses when there is no default printer", async () => {
    const { cups } = fakeCups({
      ...idle,
      defaultDestination: LPSTAT_DEFAULT_NONE,
    });
    const result = await cups.check();
    expect(result).toEqual({
      ok: false,
      message:
        "No default printer: pass --printer, or set printQueue in the extension preferences",
    });
  });

  it("refuses a queue that does not exist", async () => {
    const { cups } = fakeCups({ ...idle, printer: () => PRINTER_NOT_FOUND });
    const result = await cups.check("no-such-queue");
    expect(result).toEqual({
      ok: false,
      message: 'No printer named "no-such-queue"',
    });
  });

  it("refuses a queue that is not accepting jobs", async () => {
    const { cups } = fakeCups({
      ...idle,
      printer: () => PRINTER_STOPPED.replace("= true", "= false"),
    });
    const result = await cups.check();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not accepting jobs");
  });

  it("refuses a stopped queue", async () => {
    const { cups } = fakeCups({
      ...idle,
      printer: () => PRINTER_STOPPED.replace("= false", "= true"),
    });
    const result = await cups.check();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("is stopped");
  });

  it("counts the active jobs", async () => {
    const { cups } = fakeCups({ ...idle, jobs: () => JOBS_HELD });
    const result = await cups.check();
    expect(result.ok && result.value.queued).toBe(1);
  });
});

describe("submit", () => {
  const request: PrintRequest & { printer: string } = {
    file: "/tmp/x.pdf",
    printer: "Example_Printer",
    sides: "two-sided-long-edge",
    pages: "1-3,5",
    copies: 2,
    nUp: 1,
    manualFeed: false,
    media: "A4",
    hold: false,
  };

  it("runs lp with the explicit argv and returns the job id", async () => {
    const { cups, calls } = fakeCups(idle);
    const result = await cups.submit(request);
    expect(result).toEqual({ ok: true, value: "Example_Printer-27" });
    expect(calls.filter((c) => c.file === "lp")).toEqual([
      {
        file: "lp",
        args: [
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
          "/tmp/x.pdf",
        ],
      },
    ]);
  });

  it("reports a refused lp with its first stderr line", async () => {
    const { cups } = fakeCups({
      ...idle,
      lpCode: 1,
      lpStderr: "lp: bad\nmore",
    });
    const result = await cups.submit(request);
    expect(result).toEqual({
      ok: false,
      message: "lp did not accept the file: lp: bad",
    });
  });
});

describe("cancelAll", () => {
  it("cancels only the current user's active jobs", async () => {
    const someoneElse = `        -- separator --
        job-originating-user-name (nameWithoutLanguage) = someone-else
        job-name (nameWithoutLanguage) = Example-Other.pdf
        job-id (integer) = 28
        job-state (enum) = pending
        job-state-reasons (keyword) = none
`;
    const { cups, calls } = fakeCups({
      ...idle,
      jobs: () => JOBS_HELD + someoneElse,
    });
    const result = await cups.cancelAll();
    expect(result).toEqual({ ok: true, value: ["Example_Printer-27"] });
    expect(calls.filter((c) => c.file === "cancel")).toEqual([
      { file: "cancel", args: ["Example_Printer-27"] },
    ]);
  });

  it("cancels nothing from an empty queue", async () => {
    const { cups, calls } = fakeCups(idle);
    expect(await cups.cancelAll()).toEqual({ ok: true, value: [] });
    expect(calls.some((c) => c.file === "cancel")).toBe(false);
  });
});

describe("job and waitFor", () => {
  it("reads one job by its id through the job URI", async () => {
    const { cups } = fakeCups(idle);
    const result = await cups.job("Example_Printer-26");
    expect(result.ok && result.value.state).toBe("completed");
  });

  it("refuses an id that is not a job id", async () => {
    const { cups } = fakeCups(idle);
    expect(await cups.job("Example_Printer")).toEqual({
      ok: false,
      message: "Not a job id: Example_Printer",
    });
  });

  it("returns at once when the job has ended", async () => {
    const { cups } = fakeCups(idle);
    const result = await cups.waitFor("Example_Printer-26", 60_000);
    expect(result.ok && result.value).toEqual({
      job: expect.objectContaining({ state: "completed" }),
      timedOut: false,
    });
  });

  it("reports a timeout while the job is still running", async () => {
    const processing = JOB_ONE.replace(
      "job-state (enum) = completed",
      "job-state (enum) = processing",
    );
    const { cups } = fakeCups({ ...idle, job: () => processing });
    const result = await cups.waitFor("Example_Printer-26", 3000);
    expect(result.ok && result.value.timedOut).toBe(true);
    expect(result.ok && result.value.job.state).toBe("processing");
  });

  it("drops finished jobs from the active list", async () => {
    const { cups } = fakeCups({ ...idle, jobs: () => JOBS_COMPLETED });
    expect(await cups.jobs("Example_Printer")).toEqual({ ok: true, value: [] });
  });
});
