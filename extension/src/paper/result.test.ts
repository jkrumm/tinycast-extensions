import { describe, expect, it } from "vitest";
import { PAPER_SILENT, parseResult } from "./result";

describe("parseResult", () => {
  it("returns paper's message, ok or not", () => {
    expect(parseResult('{"ok":true,"message":"Scanning"}')).toEqual({
      ok: true,
      message: "Scanning",
    });
    expect(parseResult('{"ok":false,"message":"Scanner busy"}')).toEqual({
      ok: false,
      message: "Scanner busy",
    });
  });

  it("reads the last JSON line", () => {
    expect(
      parseResult('log line\n{"ok":true,"message":"Filed"}\n').message,
    ).toBe("Filed");
  });

  it("fails with a fixed message on anything else", () => {
    for (const out of ["", "not json", "{broken", '{"ok":true}', "[1]"]) {
      expect(parseResult(out)).toEqual({ ok: false, message: PAPER_SILENT });
    }
  });
});
