import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseNetworkQuality, toSpeedTestRecord } from "./parse";

// Real `networkQuality` output, captured live on this machine — not
// synthesized, so the parser is checked against the actual field set/types.
const fullRaw = readFileSync(
  join(__dirname, "fixtures/networkquality-full.fixture.json"),
  "utf8",
);
const quickRaw = readFileSync(
  join(__dirname, "fixtures/networkquality-quick.fixture.json"),
  "utf8",
);

describe("parseNetworkQuality", () => {
  it("parses a full test (has ul_throughput + responsiveness)", () => {
    const result = parseNetworkQuality(fullRaw);
    expect(result.dl_throughput).toBeGreaterThan(0);
    expect(result.ul_throughput).toBeGreaterThan(0);
    expect(result.responsiveness).toBeGreaterThan(0);
  });

  it("parses a quick test (no ul_throughput/responsiveness keys)", () => {
    const result = parseNetworkQuality(quickRaw);
    expect(result.dl_throughput).toBeGreaterThan(0);
    expect(result.ul_throughput).toBeUndefined();
    expect(result.responsiveness).toBeUndefined();
  });
});

describe("toSpeedTestRecord", () => {
  it("converts a full test to Mbps/MB, both directions present", () => {
    const result = parseNetworkQuality(fullRaw);
    const record = toSpeedTestRecord(result, true, 1000);
    expect(record).toEqual({
      timestamp: 1000,
      full: true,
      dlMbps: 138.6,
      ulMbps: 25.2,
      latencyMs: 61.9,
      responsiveness: result.responsiveness,
      dataUsedMB: round1(
        (result.dl_bytes_transferred + (result.ul_bytes_transferred ?? 0)) /
          1_000_000,
      ),
      interfaceName: "en0",
    });
  });

  it("converts a quick test with a null upload and null responsiveness", () => {
    const result = parseNetworkQuality(quickRaw);
    const record = toSpeedTestRecord(result, false, 2000);
    expect(record.full).toBe(false);
    expect(record.ulMbps).toBeNull();
    expect(record.responsiveness).toBeNull();
    expect(record.dlMbps).toBeGreaterThan(0);
    expect(record.dataUsedMB).toBeCloseTo(
      result.dl_bytes_transferred / 1_000_000,
      1,
    );
  });

  it("defaults timestamp to Date.now() when omitted", () => {
    const before = Date.now();
    const record = toSpeedTestRecord(parseNetworkQuality(quickRaw), false);
    expect(record.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("throws instead of producing a null record when offline (dl_throughput missing)", () => {
    const result = parseNetworkQuality(fullRaw);
    expect(() =>
      toSpeedTestRecord(
        { ...result, dl_throughput: undefined as unknown as number },
        true,
      ),
    ).toThrow("Speed test failed — no connection?");
  });

  it("throws when dl_throughput is 0", () => {
    const result = parseNetworkQuality(quickRaw);
    expect(() =>
      toSpeedTestRecord({ ...result, dl_throughput: 0 }, false),
    ).toThrow("Speed test failed — no connection?");
  });
});

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
