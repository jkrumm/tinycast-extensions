import { beforeEach, describe, expect, it, vi } from "vitest";
import { __hudMessages, __openedTargets } from "./raycast-fake";

// Only the paper call is mocked: each command runs its real code against the
// canned one-line JSON answers below, and the HUD shows paper's message.
const paper = vi.hoisted(() => ({
  answer: "",
  calls: [] as string[][],
}));

vi.mock("../paper/run", () => ({
  PAPER_BIN: "paper",
  runPaper: (args: string[]) => {
    paper.calls.push(args);
    return Promise.resolve(paper.answer);
  },
}));

import Scan from "../scan";
import ScanFronts from "../scan-fronts";
import ScanBacks from "../scan-backs";
import ScanFlatbed from "../scan-flatbed";
import ScanMore from "../scan-more";
import ScanSubmit from "../scan-submit";
import ScanDiscard from "../scan-discard";
import PrintSelection from "../print-selection";
import PrintSelectionSimplex from "../print-selection-simplex";
import PrintCancel from "../print-cancel";
import Documents from "../documents";

const say = (message: string, ok = true) => {
  paper.answer = JSON.stringify({ ok, message });
};

describe("scan and print commands", () => {
  beforeEach(() => {
    paper.calls = [];
    paper.answer = "";
    __hudMessages.length = 0;
    __openedTargets.length = 0;
  });

  it.each([
    ["Scan Document", Scan, "feeder"],
    ["Scan Fronts", ScanFronts, "fronts"],
    ["Scan Backs", ScanBacks, "backs"],
    ["Scan Flatbed", ScanFlatbed, "flatbed"],
    ["Scan More", ScanMore, "more"],
  ])(
    "%s starts a %s scan and shows paper's message",
    async (_n, command, mode) => {
      say("Scanning: 3 sheets");
      await command();
      expect(paper.calls).toEqual([["scan", "start", "--mode", mode]]);
      expect(__hudMessages).toEqual(["Scanning: 3 sheets"]);
    },
  );

  it("Scan Submit and Scan Discard show paper's message", async () => {
    say("Filed: 3 pages");
    await ScanSubmit();
    say("Discarded", true);
    await ScanDiscard();
    expect(paper.calls).toEqual([
      ["scan", "submit"],
      ["scan", "discard"],
    ]);
    expect(__hudMessages).toEqual(["Filed: 3 pages", "Discarded"]);
  });

  it("shows a refusal and a silent paper as the HUD", async () => {
    say("Feeder is empty", false);
    await Scan();
    paper.answer = "";
    await ScanSubmit();
    expect(__hudMessages).toEqual(["Feeder is empty", "paper did not answer"]);
  });

  it("Cancel Print Jobs cancels all jobs through paper", async () => {
    say("Cancelled 2 jobs");
    await PrintCancel();
    expect(paper.calls).toEqual([["print", "cancel", "--all"]]);
    expect(__hudMessages).toEqual(["Cancelled 2 jobs"]);
  });

  it("Print Selection asks for a Finder file first and never calls paper", async () => {
    await PrintSelection();
    await PrintSelectionSimplex();
    expect(paper.calls).toEqual([]);
    expect(__hudMessages).toEqual([
      "Select a file in Finder first",
      "Select a file in Finder first",
    ]);
  });

  it("Documents opens Argo's Documents page, not the API", async () => {
    await Documents();
    expect(__openedTargets).toHaveLength(1);
    expect(__openedTargets[0]).toMatch(/^https:\/\/[^/]+\/documents$/);
    expect(__openedTargets[0]).not.toContain("/api");
  });
});
