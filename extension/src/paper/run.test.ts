import { describe, expect, it } from "vitest";
import { PAPER_BIN } from "./run";

describe("runPaper", () => {
  it("spawns the paper CLI from ~/.local/bin", () => {
    expect(PAPER_BIN.endsWith("/.local/bin/paper")).toBe(true);
  });
});
