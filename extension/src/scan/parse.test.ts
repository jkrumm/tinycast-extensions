import { describe, expect, it } from "vitest";
import { CHECK_FAILED, parseCheckLine } from "./parse";

describe("parseCheckLine", () => {
  it("reads ok", () => {
    expect(parseCheckLine('{"ok":true}\n')).toEqual({ ok: true });
  });

  it("reads a failure message", () => {
    expect(parseCheckLine('{"ok":false,"message":"Scanner is busy"}')).toEqual({
      ok: false,
      message: "Scanner is busy",
    });
  });

  it("finds the JSON line among other output", () => {
    expect(
      parseCheckLine(
        'warning: something\n{"ok":false,"message":"No document in the feeder"}\n',
      ),
    ).toEqual({ ok: false, message: "No document in the feeder" });
  });

  it("turns anything else into a plain failure", () => {
    for (const bad of [
      "",
      "garbage",
      "{not json",
      "{}",
      '{"ok":"yes"}',
      '{"ok":false}',
      '{"ok":false,"message":""}',
    ]) {
      expect(parseCheckLine(bad)).toEqual(CHECK_FAILED);
    }
    expect(CHECK_FAILED).toEqual({ ok: false, message: "Scan check failed" });
  });
});
