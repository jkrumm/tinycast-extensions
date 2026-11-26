import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { LOG_MAX_BYTES } from "../lib/action-log";
import { appendScanLog } from "./log";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "scan-log-"));
  dirs.push(dir);
  return dir;
};

describe("appendScanLog", () => {
  it("appends one timestamped line per call", () => {
    const path = join(tmp(), "scan.log");
    const now = new Date("2026-11-26T18:00:00Z");
    appendScanLog(path, "start", now);
    appendScanLog(path, "two\nlines", now);
    expect(readFileSync(path, "utf8")).toBe(
      "2026-11-26T18:00:00.000Z  start\n2026-11-26T18:00:00.000Z  two ⏎ lines\n",
    );
  });

  it("rotates to scan.log.1 past 512 KB", () => {
    const path = join(tmp(), "scan.log");
    writeFileSync(path, "x".repeat(LOG_MAX_BYTES + 1));
    appendScanLog(path, "fresh", new Date(0));
    expect(readFileSync(`${path}.1`, "utf8")).toHaveLength(LOG_MAX_BYTES + 1);
    expect(readFileSync(path, "utf8")).toContain("fresh");
    expect(existsSync(`${path}.1`)).toBe(true);
  });

  it("never throws", () => {
    expect(() =>
      appendScanLog("/nonexistent-dir/scan.log", "x", new Date()),
    ).not.toThrow();
  });
});
