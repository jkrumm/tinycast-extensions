import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLogLine,
  formatLogLine,
  LOG_MAX_BYTES,
  readLogTail,
} from "./action-log";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "action-log-"));
  path = join(dir, "netgear.log");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const now = new Date(2026, 9, 2, 11, 30, 1);

describe("formatLogLine", () => {
  it("renders fixed-width columns with local time", () => {
    expect(
      formatLogLine({
        source: "ui",
        action: "Reconnect",
        outcome: "failed",
        message: "Router refused the disconnect request",
        now,
      }),
    ).toBe(
      "2026-10-02 11:30:01  ui        Reconnect           failed   Router refused the disconnect request",
    );
  });

  it("appends detail only when it adds information", () => {
    const base = {
      source: "ui",
      action: "Reconnect",
      outcome: "failed",
      message: "boom",
      now,
    };
    expect(formatLogLine({ ...base, detail: "boom" })).not.toContain("[raw:");
    expect(formatLogLine({ ...base, detail: "" })).not.toContain("[raw:");
    expect(formatLogLine({ ...base, detail: "TypeError: x" })).toMatch(
      /boom {2}\[raw: TypeError: x\]$/,
    );
  });

  it("collapses newlines in detail and truncates it", () => {
    const line = formatLogLine({
      source: "ui",
      action: "a",
      outcome: "failed",
      message: "m",
      detail: `first\nsecond\r\nthird ${"x".repeat(900)}`,
      now,
    });
    expect(line).not.toContain("\n");
    expect(line).toContain("[raw: first ⏎ second ⏎ third ");
    expect(line.endsWith("…]")).toBe(true);
    expect(line.length).toBeLessThan(800);
  });
});

describe("appendLogLine / readLogTail", () => {
  it("appends one line per call and reads the tail", async () => {
    for (const action of ["a", "b", "c"]) {
      appendLogLine({
        path,
        source: "ui",
        action,
        outcome: "ok",
        message: "done",
        now,
      });
    }
    const raw = await readFile(path, "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(3);
    const tail = readLogTail(path, 2);
    expect(tail).toHaveLength(2);
    expect(tail[1]).toContain(" c ");
  });

  it("returns [] for a missing file", () => {
    expect(readLogTail(join(dir, "nope.log"), 10)).toEqual([]);
  });

  it("rotates to <path>.1 once the file exceeds the limit", async () => {
    await writeFile(path, "x".repeat(LOG_MAX_BYTES + 1));
    await writeFile(`${path}.1`, "stale");
    appendLogLine({
      path,
      source: "ui",
      action: "a",
      outcome: "ok",
      message: "fresh",
      now,
    });
    expect((await readFile(`${path}.1`, "utf8")).length).toBe(
      LOG_MAX_BYTES + 1,
    );
    expect(readLogTail(path, 10)).toHaveLength(1);
  });

  it("never throws, even when the path is unwritable", () => {
    expect(() =>
      appendLogLine({
        path: join(dir, "missing-dir", "netgear.log"),
        source: "ui",
        action: "a",
        outcome: "ok",
        message: "m",
      }),
    ).not.toThrow();
  });
});
