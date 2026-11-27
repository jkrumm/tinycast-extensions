import { describe, expect, it, vi } from "vitest";
import {
  NOTHING_SELECTED,
  cancelAllPrints,
  cancelJob,
  printPaths,
  scanDiscard,
  scanStart,
  scanSubmit,
} from "./actions";
import { RunPaper } from "./run";

const answer = (message: string, ok = true) => JSON.stringify({ ok, message });

const fake = (...answers: string[]) => {
  const calls: string[][] = [];
  const run: RunPaper = vi.fn((args: string[]) => {
    calls.push(args);
    return Promise.resolve(answers[calls.length - 1] ?? answers.at(-1) ?? "");
  });
  return { run, calls };
};

describe("scan commands", () => {
  it("start the scan in the mode and show paper's message", async () => {
    const { run, calls } = fake(answer("Scanning 1 page"));
    const result = await scanStart("fronts", run);
    expect(calls).toEqual([["scan", "start", "--mode", "fronts"]]);
    expect(result).toEqual({ ok: true, message: "Scanning 1 page" });
  });

  it("submit and discard call their verbs", async () => {
    const { run, calls } = fake(answer("Filed: 3 pages"));
    await scanSubmit(run);
    await scanDiscard(run);
    expect(calls).toEqual([
      ["scan", "submit"],
      ["scan", "discard"],
    ]);
  });

  it("show a refusal as it is", async () => {
    const { run } = fake(answer("Scanner busy", false));
    expect(await scanStart("feeder", run)).toEqual({
      ok: false,
      message: "Scanner busy",
    });
  });

  it("read a silent paper as a failure", async () => {
    const { run } = fake("");
    expect((await scanSubmit(run)).message).toBe("paper did not answer");
  });
});

describe("printPaths", () => {
  it("refuses an empty selection without calling paper", async () => {
    const { run, calls } = fake(answer("x"));
    expect(await printPaths("two-sided", [], run)).toEqual({
      ok: false,
      message: NOTHING_SELECTED,
    });
    expect(calls).toEqual([]);
  });

  it("refuses more than five files", async () => {
    const { run, calls } = fake(answer("x"));
    const paths = Array.from({ length: 6 }, (_, i) => `/f${i}.pdf`);
    const result = await printPaths("two-sided", paths, run);
    expect(result.message).toBe("Select at most 5 files (6 selected)");
    expect(calls).toEqual([]);
  });

  it("prints one file two-sided with no flag, paper picks the edge", async () => {
    const { run, calls } = fake(answer("Printing a.pdf, two-sided"));
    const result = await printPaths("two-sided", ["/a.pdf"], run);
    expect(calls).toEqual([["print", "/a.pdf"]]);
    expect(result).toEqual({ ok: true, message: "Printing a.pdf, two-sided" });
  });

  it("asks for one-sided with --simplex", async () => {
    const { run, calls } = fake(answer("ok"));
    await printPaths("one-sided", ["/a.pdf"], run);
    expect(calls).toEqual([["print", "/a.pdf", "--simplex"]]);
  });

  it("stops at the first refusal and says how many went out", async () => {
    const { run, calls } = fake(
      answer("sent a"),
      answer("Printer stopped", false),
    );
    const result = await printPaths(
      "two-sided",
      ["/a.pdf", "/b.pdf", "/c.pdf"],
      run,
    );
    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      ok: false,
      message: "Printer stopped (1 of 3 submitted)",
    });
  });

  it("summarises several files", async () => {
    const { run } = fake(answer("sent"));
    const result = await printPaths("one-sided", ["/a.pdf", "/b.pdf"], run);
    expect(result).toEqual({
      ok: true,
      message: "Printing 2 files (one-sided)",
    });
  });
});

describe("cancel", () => {
  it("cancels one job or all of them through paper", async () => {
    const { run, calls } = fake(answer("Cancelled"));
    await cancelJob("Q-4", run);
    await cancelAllPrints(run);
    expect(calls).toEqual([
      ["print", "cancel", "Q-4"],
      ["print", "cancel", "--all"],
    ]);
  });
});
