import { describe, it, expect } from "vitest";
import {
  describeErrorDetail,
  describeNetgearError,
  ROUTER_UNREACHABLE_MESSAGE,
  isRouterRejection,
} from "./errors";

describe("describeNetgearError", () => {
  it("maps curl exit 7 to a friendly reachability message", () => {
    expect(
      describeNetgearError(new Error("curl exited 7: Failed to connect")),
    ).toBe(ROUTER_UNREACHABLE_MESSAGE);
  });

  it("maps curl exit 28 the same way", () => {
    expect(
      describeNetgearError(
        new Error("curl exited 28: Operation timed out after 8000ms"),
      ),
    ).toBe(ROUTER_UNREACHABLE_MESSAGE);
  });

  it("maps a Node-level connection errno the same way", () => {
    expect(describeNetgearError(new Error("connect ECONNREFUSED"))).toBe(
      ROUTER_UNREACHABLE_MESSAGE,
    );
  });

  it("maps a router rejection to a labelled, actionable message, dropping the raw body", () => {
    expect(
      describeNetgearError(
        new Error(
          'Router rejected the disconnect request: { "success": false }',
        ),
      ),
    ).toBe(
      "Router refused the disconnect request — it may be busy or the session expired. Try again.",
    );
    expect(
      describeNetgearError(new Error("Router rejected the SIM PIN request: x")),
    ).toContain("Router refused the SIM PIN request");
  });

  it("maps unparseable router pages to an 'it may be restarting' message", () => {
    const expected =
      "Router answered with an unexpected page — it may be restarting. Try again in a minute.";
    for (const raw of [
      "JSON Parse error: Unrecognized token '<'",
      "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
      "Unexpected token < in JSON at position 0",
      "Unexpected end of JSON input",
    ]) {
      expect(describeNetgearError(new SyntaxError(raw))).toBe(expected);
    }
  });

  it("maps connect/disconnect timeouts, naming the state it got stuck in", () => {
    expect(
      describeNetgearError(
        new Error("Timed out waiting to connect (last state: Disconnected)."),
      ),
    ).toBe(
      "Router did not connect within the time limit (still Disconnected). Check the SIM has data and the APN is right.",
    );
    expect(
      describeNetgearError(
        new Error("Timed out waiting to disconnect (last state: Connected)."),
      ),
    ).toBe(
      "Router did not drop the connection in time (still Connected). Try again, or Restart & Reconnect.",
    );
  });

  it("maps other curl exit codes to a network error with the code", () => {
    expect(describeNetgearError(new Error("curl exited 6: no host"))).toBe(
      "Network error talking to the router (curl 6).",
    );
  });

  it("maps runtime/programming errors to an internal-error pointer at the log", () => {
    const expected =
      "Internal extension error — see the Netgear log (make logs).";
    expect(
      describeNetgearError(new TypeError("x.open is not a function")),
    ).toBe(expected);
    expect(describeNetgearError(new TypeError("whatever"))).toBe(expected);
    expect(
      describeNetgearError(
        new Error("undefined is not an object (evaluating 'a.b')"),
      ),
    ).toBe(expected);
  });

  it("passes through anything else unchanged", () => {
    expect(describeNetgearError(new Error("SIM PIN was not accepted"))).toBe(
      "SIM PIN was not accepted",
    );
  });

  it("stringifies a non-Error value", () => {
    expect(describeNetgearError("boom")).toBe("boom");
  });
});

describe("isRouterRejection", () => {
  it("matches only labelled router rejections", () => {
    expect(
      isRouterRejection(new Error("Router rejected the connect request: x")),
    ).toBe(true);
    expect(isRouterRejection(new Error("curl exited 7"))).toBe(false);
    expect(isRouterRejection("boom")).toBe(false);
  });
});

describe("describeErrorDetail", () => {
  it("returns the message plus up to three stack frames, without repeating the message", () => {
    const e = new Error("boom");
    e.stack = "Error: boom\n  at a (x:1)\n  at b (x:2)\n  at c (x:3)\n  at d";
    expect(describeErrorDetail(e)).toBe(
      "boom\nat a (x:1)\nat b (x:2)\nat c (x:3)",
    );
  });

  it("stringifies a non-Error value", () => {
    expect(describeErrorDetail("boom")).toBe("boom");
  });
});
