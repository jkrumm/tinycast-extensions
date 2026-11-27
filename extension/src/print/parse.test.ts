import { describe, expect, it } from "vitest";
import { parsePrinterView } from "./parse";

const job = {
  id: "Example_Printer-26",
  title: "Example-Invoice.pdf",
  state: "processing",
  reasons: [],
  user: "user",
  submittedAt: 1795782227,
  sheets: 3,
};
const status = {
  ok: true,
  printer: "Example_Printer",
  state: "idle",
  accepting: true,
  reasons: [],
  tonerPercent: 100,
  tonerLow: false,
  warnings: [],
  jobs: [job],
};

describe("parsePrinterView", () => {
  it("reads paper print status", () => {
    const view = parsePrinterView(JSON.stringify(status));
    expect(view).toEqual({
      ok: true,
      printer: "Example_Printer",
      state: "idle",
      accepting: true,
      reasons: [],
      tonerPercent: 100,
      tonerLow: false,
      jobs: [job],
    });
  });

  it("takes the last JSON line and ignores other output", () => {
    const view = parsePrinterView(`noise\n${JSON.stringify(status)}\n`);
    expect(view.ok).toBe(true);
  });

  it("keeps a null toner and drops a malformed job", () => {
    const view = parsePrinterView(
      JSON.stringify({
        ...status,
        tonerPercent: null,
        jobs: [job, { id: "x" }, null],
      }),
    );
    expect(view.ok && view.tonerPercent).toBeNull();
    expect(view.ok && view.jobs).toEqual([job]);
  });

  it("reports paper's own refusal", () => {
    expect(
      parsePrinterView('{"ok":false,"message":"No printer named \'x\'"}'),
    ).toEqual({ ok: false, message: "No printer named 'x'" });
  });

  it("says paper did not answer for empty or non-JSON output", () => {
    const silent = { ok: false, message: "paper did not answer" };
    expect(parsePrinterView("")).toEqual(silent);
    expect(parsePrinterView("zsh: command not found: paper")).toEqual(silent);
  });

  it("refuses an unknown shape", () => {
    const view = parsePrinterView(
      JSON.stringify({ ...status, state: "weird" }),
    );
    expect(view).toEqual({
      ok: false,
      message: "paper answered in an unknown shape",
    });
  });
});
