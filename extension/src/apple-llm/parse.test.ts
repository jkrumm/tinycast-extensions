import { describe, expect, it } from "vitest";
import { describeLlmError, parseLlmReply } from "./parse";

describe("parseLlmReply", () => {
  it("returns the results of an ok reply", () => {
    expect(
      parseLlmReply('{"ok":true,"available":true,"results":["Hello"]}\n'),
    ).toEqual({
      ok: true,
      results: ["Hello"],
    });
  });
  it("marks an unavailable model", () => {
    const r = parseLlmReply(
      '{"ok":false,"available":false,"results":[],"error":"on-device model unavailable: appleIntelligenceNotEnabled"}',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.available).toBe(false);
    expect(describeLlmError(r)).toContain("Apple Intelligence is off");
  });
  it("does not throw on non-JSON output", () => {
    expect(parseLlmReply("dyld: Library not loaded")).toMatchObject({
      ok: false,
    });
  });
  it("maps model refusals to a friendly message", () => {
    const r = parseLlmReply(
      '{"ok":false,"available":true,"results":[""],"error":"guardrailViolation(x)"}',
    );
    if (r.ok) throw new Error("expected failure");
    expect(describeLlmError(r)).toContain("safety filter");
  });
  it("reports empty output", () => {
    expect(parseLlmReply("")).toMatchObject({ ok: false });
  });
});
