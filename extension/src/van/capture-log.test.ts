import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_LOG_KEEP_MS,
  CAPTURE_LOG_TRIM_BYTES,
  CaptureLogEntry,
  TRENDS_LOG_KEEP_MS,
  TRENDS_LOG_TRIM_BYTES,
  appendCaptureLog,
  appendEstimateUpdate,
  estimateUpdateEntry,
  appendTrendsLog,
  captureLogEntry,
  parseCaptureLog,
  parseTrendsLog,
  parseVictronReadLog,
  summariseVictronReads,
  trendsLogLine,
  appendVictronReadLog,
} from "./capture-log";
import {
  HELPER_BATTERY_BUSY,
  HELPER_FULL,
  fixtureVictronAll,
} from "./fixtures";
import { compactTrends } from "./history";
import { toReading } from "./parse";

const NOW = new Date(2026, 9, 5, 12, 0).getTime();
const DAY = 86_400_000;
const dir = () => mkdtempSync(join(tmpdir(), "van-log-test-"));
const reading = toReading({ helper: HELPER_FULL, keyMissing: false, now: NOW });

describe("captureLogEntry", () => {
  it("is the exact Ective reading, the Victron's live numbers and the prediction", () => {
    const entry = captureLogEntry(reading, 91.234)!;
    expect(entry).toMatchObject({
      t: NOW,
      ective: {
        soc: reading.battery!.soc,
        currentA: reading.battery!.currentA,
        voltageV: reading.battery!.cellSumV,
        capacityAh: reading.battery!.capacityAh,
        tempC: reading.battery!.tempC,
      },
      victron: {
        chargeA: reading.solar!.chargeA,
        batteryV: reading.solar!.batteryV,
        pvW: reading.solar!.solarW,
        state: reading.solar!.stateLabel,
      },
      estimateAtT: 91.2,
    });
  });

  it("victron is null without a solar reading, estimateAtT null without an estimate, nothing without a battery", () => {
    const noSolar = captureLogEntry({ ...reading, solar: null }, null)!;
    expect(noSolar.victron).toBeNull();
    expect(noSolar.estimateAtT).toBeNull();
    expect(
      captureLogEntry({ ...reading, estimate: undefined } as never, NaN)!
        .estimateAtT,
    ).toBeNull();
    const busy = toReading({
      helper: HELPER_BATTERY_BUSY,
      keyMissing: false,
      now: NOW,
    });
    expect(captureLogEntry(busy, 50)).toBeNull();
  });
});

describe("appendCaptureLog", () => {
  const entry = (t: number): CaptureLogEntry => ({
    ...captureLogEntry(reading, 80)!,
    t,
  });

  it("appends one JSON line per call, creating the directory, and parses back", () => {
    const path = join(dir(), "nested", "van-log.jsonl");
    appendCaptureLog({ path, entry: entry(NOW - 1000), now: NOW });
    appendCaptureLog({ path, entry: entry(NOW), now: NOW });
    const text = readFileSync(path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(parseCaptureLog(text).map((e) => e.t)).toEqual([NOW - 1000, NOW]);
  });

  it("a torn or foreign line does not hide the rest", () => {
    const text = `${JSON.stringify(entry(NOW))}\n{"t": 1, "ective"\nnot json\n{"other":true}\n${JSON.stringify(entry(NOW + 1))}\n`;
    expect(parseCaptureLog(text).map((e) => e.t)).toEqual([NOW, NOW + 1]);
  });

  it("trims to 60 days once the file has outgrown its budget", () => {
    const path = join(dir(), "van-log.jsonl");
    const old = JSON.stringify(entry(NOW - CAPTURE_LOG_KEEP_MS - DAY));
    const recent = JSON.stringify(entry(NOW - 5 * DAY));
    const filler = `${recent}\n`.repeat(
      Math.ceil(CAPTURE_LOG_TRIM_BYTES / (recent.length + 1)),
    );
    writeFileSync(path, `${old}\n${filler}`);
    appendCaptureLog({ path, entry: entry(NOW), now: NOW });
    const kept = parseCaptureLog(readFileSync(path, "utf8"));
    expect(kept.some((e) => e.t < NOW - CAPTURE_LOG_KEEP_MS)).toBe(false);
    expect(kept.at(-1)!.t).toBe(NOW);
    expect(kept.length).toBeGreaterThan(100);
  });

  it("never throws, even when the path cannot be written", () => {
    expect(() =>
      appendCaptureLog({
        path: "/dev/null/impossible/van-log.jsonl",
        entry: entry(NOW),
        now: NOW,
      }),
    ).not.toThrow();
  });
});

describe("the trends log", () => {
  const all = fixtureVictronAll(NOW);
  const trends = compactTrends(all.trends)!;

  it("keeps battery A, battery V and PV W at native resolution, and rebuilds them", () => {
    const line = trendsLogLine(trends, NOW)!;
    expect(line.readAt).toBe(NOW);
    for (const key of ["A", "V", "W"] as const) {
      expect(line[key].length).toBeGreaterThan(200);
    }
    const rebuilt = parseTrendsLog(`${JSON.stringify(line)}\n`)!;
    expect(rebuilt.trends.map((t) => t.vreg).sort()).toEqual([
      0xec8a, 0xed8d, 0xed8f,
    ]);
    const original = trends.trends.find((t) => t.vreg === 0xed8f)!.samples;
    const back = rebuilt.trends.find((t) => t.vreg === 0xed8f)!.samples;
    expect(back).toHaveLength(original.length);
    expect(back[10]).toEqual({ t: original[10].t, v: original[10].v });
    expect(trendsLogLine(null, NOW)).toBeNull();
    expect(trendsLogLine({ ...trends, trends: [] }, NOW)).toBeNull();
  });

  it("merges the lines of many reads, deduplicating jittered samples and letting a later read win", () => {
    const first = trendsLogLine(trends, NOW)!;
    const jittered = {
      ...first,
      readAt: NOW + 40 * 60_000,
      A: first.A.map(
        ([t, v]) =>
          [t + 7, v === null ? null : v + 1] as [number, number | null],
      ),
    };
    const merged = parseTrendsLog(
      `${JSON.stringify(first)}\n${JSON.stringify(jittered)}\n`,
    )!;
    const a = merged.trends.find((t) => t.vreg === 0xed8f)!.samples;
    expect(a).toHaveLength(first.A.length); // not doubled
    expect(a[5].v).toBe((first.A[5][1] ?? 0) + 1); // the later read
    expect(a.map((s) => s.t)).toEqual(
      [...a.map((s) => s.t)].sort((x, y) => x - y),
    );
    expect(parseTrendsLog("")).toBeNull();
    expect(parseTrendsLog("garbage\n")).toBeNull();
  });

  it("appends lines and trims reads whose newest sample is over 30 days old", () => {
    const path = join(dir(), "van-trends.jsonl");
    const line = trendsLogLine(trends, NOW)!;
    const oldSample: [number, number] = [NOW - TRENDS_LOG_KEEP_MS - DAY, 1];
    const old = {
      readAt: NOW - TRENDS_LOG_KEEP_MS - DAY,
      A: [oldSample],
      V: [],
      W: [],
    };
    const filler = `${JSON.stringify(line)}\n`.repeat(
      Math.ceil(TRENDS_LOG_TRIM_BYTES / (JSON.stringify(line).length + 1)),
    );
    writeFileSync(path, `${JSON.stringify(old)}\n${filler}`);
    appendTrendsLog({ path, line, now: NOW });
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(`"readAt":${old.readAt}`);
    expect(parseTrendsLog(text)).not.toBeNull();
    expect(() =>
      appendTrendsLog({ path: "/dev/null/x/van-trends.jsonl", line, now: NOW }),
    ).not.toThrow();
  });
});

describe("Victron read log", () => {
  const read = (
    t: number,
    victronRead: Parameters<
      typeof appendVictronReadLog
    >[0]["entry"]["victronRead"],
  ) => ({ t, victronRead });

  it("pairs each start with its end and names a read that never finished", () => {
    const rows = summariseVictronReads([
      read(1, { phase: "start", sinceMs: null, history: true }),
      read(2, {
        phase: "done",
        ms: 21_000,
        newSamples: 400,
        historyDays: 30,
        errors: [],
      }),
      read(3, { phase: "start", sinceMs: 5, history: false }),
      read(4, { phase: "failed", ms: 3000, reason: "victron-connect-failed" }),
      read(5, { phase: "start", sinceMs: 9, history: false }), // the view closed
      read(6, { phase: "start", sinceMs: 9, history: false }), // …and the next open
    ]);
    expect(rows.map((r) => r.outcome)).toEqual([
      "done",
      "failed",
      "cut short",
      "cut short",
    ]);
    expect(rows[0]).toMatchObject({
      newSamples: 400,
      historyDays: 30,
      history: true,
      sinceMs: null,
    });
    expect(rows[1].detail).toBe("victron-connect-failed");
    expect(rows[2].detail).toContain("view closed");
  });

  it("is appended to the same file as the captures and read back apart from them", () => {
    const path = join(dir(), "van-log.jsonl");
    appendCaptureLog({
      path,
      entry: { ...captureLogEntry(reading, 80)!, t: NOW },
      now: NOW,
    });
    appendVictronReadLog({
      path,
      entry: read(NOW + 1, { phase: "start", sinceMs: null, history: true }),
    });
    const text = readFileSync(path, "utf8");
    expect(parseCaptureLog(text)).toHaveLength(1);
    expect(parseVictronReadLog(text)).toHaveLength(1);
    expect(() =>
      appendVictronReadLog({
        path: "/dev/null/x/van-log.jsonl",
        entry: read(1, { phase: "start" }),
      }),
    ).not.toThrow();
  });
});

describe("the live prediction follows the Victron read", () => {
  const first = captureLogEntry(reading, null)!;

  it("the open's own line is provisional: no number, reason stale-trends", () => {
    expect(first.estimateAtT).toBeNull();
    expect(first.estimateReason).toBe("stale-trends");
  });

  it("an estimate-update line for the same reading replaces it when the read lands", () => {
    const path = join(dir(), "van-log.jsonl");
    appendCaptureLog({ path, entry: first, now: NOW });
    expect(parseCaptureLog(readFileSync(path, "utf8"))[0]).toMatchObject({
      estimateAtT: null,
      estimateReason: "stale-trends",
    });
    appendEstimateUpdate({ path, entry: estimateUpdateEntry(first.t, 81.26) });
    const [merged] = parseCaptureLog(readFileSync(path, "utf8"));
    expect(merged).toMatchObject({
      t: first.t,
      estimateAtT: 81.3,
      estimateReason: null,
    });
    expect(parseCaptureLog(readFileSync(path, "utf8"))).toHaveLength(1);
  });

  it("an update that has nothing to predict from says no-estimate", () => {
    expect(estimateUpdateEntry(1, null).estimateUpdate).toEqual({
      estimateAtT: null,
      reason: "no-estimate",
    });
    expect(estimateUpdateEntry(1, NaN).estimateUpdate.estimateAtT).toBeNull();
  });
});
