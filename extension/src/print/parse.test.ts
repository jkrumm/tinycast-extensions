import { describe, expect, it } from "vitest";
import {
  parseCliResult,
  parseDefaultDestination,
  parseIpp,
  parseJobs,
  parsePrinterStatus,
  parseRequestId,
  splitJobId,
} from "./parse";
import {
  JOB_ONE,
  JOBS_COMPLETED,
  JOBS_HELD,
  JOBS_NONE,
  LP_REQUEST_ID,
  LPSTAT_DEFAULT_DE,
  LPSTAT_DEFAULT_NONE,
  PRINTER_IDLE,
  PRINTER_NOT_FOUND,
  PRINTER_STOPPED,
} from "./fixtures";

describe("parseIpp", () => {
  it("reads the response after the result line, not the request echo", () => {
    const result = parseIpp(PRINTER_IDLE);
    expect(result.passed).toBe(true);
    expect(result.statusCode).toBe("successful-ok");
    const names = result.groups.flat().map((a) => a.name);
    expect(names).not.toContain("printer-uri");
    expect(names).not.toContain("requested-attributes");
  });

  it("reports a failed test with its status code", () => {
    const result = parseIpp(PRINTER_NOT_FOUND);
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe("client-error-not-found");
  });

  it("returns no groups for text without a result line", () => {
    expect(parseIpp("garbage")).toEqual({
      passed: false,
      statusCode: null,
      groups: [],
    });
  });
});

describe("parsePrinterStatus", () => {
  it("reads idle, accepting, and the toner level with its low limit", () => {
    expect(parsePrinterStatus(PRINTER_IDLE)).toEqual({
      state: "idle",
      accepting: true,
      reasons: ["toner-low-warning"],
      tonerPercent: 10,
      tonerLow: true,
    });
  });

  it("reads a stopped queue that is not accepting jobs", () => {
    const status = parsePrinterStatus(PRINTER_STOPPED);
    expect(status?.state).toBe("stopped");
    expect(status?.accepting).toBe(false);
    expect(status?.reasons).toEqual(["paused"]);
  });

  it("is not low when the level is above the low limit and no warning is set", () => {
    const text = PRINTER_IDLE.replace(
      "marker-levels (integer) = 10",
      "marker-levels (integer) = 60",
    ).replace(
      "printer-state-reasons (keyword) = toner-low-warning",
      "printer-state-reasons (keyword) = none",
    );
    expect(parsePrinterStatus(text)?.tonerLow).toBe(false);
    expect(parsePrinterStatus(text)?.tonerPercent).toBe(60);
  });

  it("reads an unknown toner level as no number", () => {
    const text = PRINTER_IDLE.replace(
      "marker-levels (integer) = 10",
      "marker-levels (integer) = -1",
    );
    expect(parsePrinterStatus(text)?.tonerPercent).toBeNull();
  });

  it("returns null for a state it does not know", () => {
    expect(
      parsePrinterStatus(PRINTER_IDLE.replace("= idle", "= warming-up")),
    ).toBeNull();
  });
});

describe("parseJobs", () => {
  it("reads no jobs from an empty queue", () => {
    expect(parseJobs(JOBS_NONE, "Example_Printer")).toEqual([]);
  });

  it("splits two completed jobs at the separator", () => {
    const jobs = parseJobs(JOBS_COMPLETED, "Example_Printer");
    expect(jobs.map((j) => j.id)).toEqual([
      "Example_Printer-26",
      "Example_Printer-25",
    ]);
    expect(jobs[0]).toEqual({
      id: "Example_Printer-26",
      title: "Example-Invoice.pdf",
      state: "completed",
      reasons: ["processing-to-stop-point"],
      user: "user",
      submittedAt: 1795782227,
      sheets: 17,
    });
    expect(jobs[1].sheets).toBe(1);
  });

  it("reads one job from Get-Job-Attributes", () => {
    const [job] = parseJobs(JOB_ONE, "Example_Printer");
    expect(job.id).toBe("Example_Printer-26");
    expect(job.state).toBe("completed");
    expect(job.title).toBe("");
  });

  it("reads a held job", () => {
    const [job] = parseJobs(JOBS_HELD, "Example_Printer");
    expect(job.state).toBe("pending-held");
    expect(job.reasons).toEqual(["job-hold-until-specified"]);
  });
});

describe("splitJobId", () => {
  it("splits the queue and the number at the last hyphen", () => {
    expect(splitJobId("Brother-Office-26")).toEqual({
      printer: "Brother-Office",
      number: 26,
    });
  });

  it("returns null without a number", () => {
    expect(splitJobId("Example_Printer")).toBeNull();
  });
});

describe("parseDefaultDestination", () => {
  it("reads the destination after the colon in the German answer", () => {
    expect(parseDefaultDestination(LPSTAT_DEFAULT_DE)).toBe("Example_Printer");
  });

  it("returns null when there is no default", () => {
    expect(parseDefaultDestination(LPSTAT_DEFAULT_NONE)).toBeNull();
  });
});

describe("parseRequestId", () => {
  it("finds the queue-number token in the lp answer", () => {
    expect(parseRequestId(LP_REQUEST_ID, "Example_Printer")).toBe(
      "Example_Printer-27",
    );
  });

  it("reads the German answer, which uses an en dash (captured live)", () => {
    expect(
      parseRequestId(
        "Anfrage-ID ist Example_Printer\u201328 (1 Datei(en))\n",
        "Example_Printer",
      ),
    ).toBe("Example_Printer-28");
  });

  it("does not match another queue", () => {
    expect(parseRequestId(LP_REQUEST_ID, "Other")).toBeNull();
  });
});

describe("parseCliResult", () => {
  it("reads a one-line result", () => {
    expect(
      parseCliResult('noise\n{"ok":true,"message":"Printing x"}\n'),
    ).toEqual({ ok: true, message: "Printing x" });
  });

  it("turns anything else into a failure", () => {
    expect(parseCliResult("not json")).toEqual({
      ok: false,
      message: "Print command failed",
    });
  });
});
