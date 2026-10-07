import { describe, expect, it } from "vitest";
import {
  nextThreshold,
  parsePingSummary,
  rateSignal,
  RSRP_BANDS,
  SINR_BANDS,
} from "./signal";

describe("rateSignal", () => {
  it.each([
    [25, "excellent"],
    [20, "excellent"],
    [19.9, "good"],
    [13, "good"],
    [12.9, "fair"],
    [0, "fair"],
    [-0.1, "poor"],
    [-1, "poor"],
  ] as const)("SINR %s dB is %s", (sinr, expected) => {
    expect(rateSignal({ sinr, rsrp: null, rsrq: null }).sinr).toBe(expected);
  });

  it.each([
    [-70, "excellent"],
    [-80, "excellent"],
    [-85, "good"],
    [-90, "good"],
    [-95, "fair"],
    [-100, "fair"],
    [-102, "poor"],
  ] as const)("RSRP %s dBm is %s", (rsrp, expected) => {
    expect(rateSignal({ sinr: null, rsrp, rsrq: null }).rsrp).toBe(expected);
  });

  it.each([
    [-8, "excellent"],
    [-10, "excellent"],
    [-12, "good"],
    [-15, "good"],
    [-18, "fair"],
    [-20, "fair"],
    [-21, "poor"],
  ] as const)("RSRQ %s dB is %s", (rsrq, expected) => {
    expect(rateSignal({ sinr: null, rsrp: null, rsrq }).rsrq).toBe(expected);
  });

  it("rates the live 2026-10-06 incident reading poor on every metric", () => {
    expect(rateSignal({ sinr: -1, rsrp: -102, rsrq: -13 })).toEqual({
      sinr: "poor",
      rsrp: "poor",
      rsrq: "good",
      overall: "poor",
    });
  });

  it("takes the worst of SINR and RSRP as the overall verdict", () => {
    expect(rateSignal({ sinr: 25, rsrp: -105, rsrq: null }).overall).toBe(
      "poor",
    );
    expect(rateSignal({ sinr: -2, rsrp: -70, rsrq: null }).overall).toBe(
      "poor",
    );
    expect(rateSignal({ sinr: 4, rsrp: -98, rsrq: null }).overall).toBe("fair");
    expect(rateSignal({ sinr: 15, rsrp: -85, rsrq: null }).overall).toBe(
      "good",
    );
  });

  it("never lets RSRQ move the verdict", () => {
    expect(rateSignal({ sinr: 25, rsrp: -70, rsrq: -30 }).overall).toBe(
      "excellent",
    );
  });

  it("falls back to the one metric that is present", () => {
    expect(rateSignal({ sinr: 4, rsrp: null, rsrq: -12 }).overall).toBe("fair");
    expect(rateSignal({ sinr: null, rsrp: -85, rsrq: -12 }).overall).toBe(
      "good",
    );
  });

  it("rates nothing without readings, and ignores non-finite ones", () => {
    expect(rateSignal({ sinr: null, rsrp: null, rsrq: null })).toEqual({
      sinr: null,
      rsrp: null,
      rsrq: null,
      overall: null,
    });
    expect(
      rateSignal({ sinr: NaN, rsrp: null, rsrq: null }).overall,
    ).toBeNull();
  });
});

describe("nextThreshold", () => {
  it("names the next rating up and where it starts", () => {
    expect(nextThreshold("poor", SINR_BANDS)).toEqual({
      rating: "fair",
      value: 0,
    });
    expect(nextThreshold("fair", SINR_BANDS)).toEqual({
      rating: "good",
      value: 13,
    });
    expect(nextThreshold("good", RSRP_BANDS)).toEqual({
      rating: "excellent",
      value: -80,
    });
  });

  it("is null when there is nothing better", () => {
    expect(nextThreshold("excellent", SINR_BANDS)).toBeNull();
    expect(nextThreshold(null, SINR_BANDS)).toBeNull();
  });
});

describe("parsePingSummary", () => {
  it("reads loss and the average round-trip from a macOS summary", () => {
    const output = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: icmp_seq=0 ttl=54 time=94.030 ms
64 bytes from 1.1.1.1: icmp_seq=1 ttl=54 time=88.716 ms

--- 1.1.1.1 ping statistics ---
4 packets transmitted, 4 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 84.410/89.769/94.030/3.627 ms
`;
    expect(parsePingSummary(output)).toEqual({ lossPercent: 0, avgMs: 89.769 });
  });

  it("reads partial loss", () => {
    const output = `--- 1.1.1.1 ping statistics ---
4 packets transmitted, 3 packets received, 25.0% packet loss
round-trip min/avg/max/stddev = 280.1/320.2/412.3/55.1 ms`;
    expect(parsePingSummary(output)).toEqual({
      lossPercent: 25,
      avgMs: 320.2,
    });
  });

  it("has no average when every packet was lost", () => {
    const output = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
Request timeout for icmp_seq 0

--- 1.1.1.1 ping statistics ---
4 packets transmitted, 0 packets received, 100.0% packet loss
`;
    expect(parsePingSummary(output)).toEqual({
      lossPercent: 100,
      avgMs: null,
    });
  });

  it("is null without a summary", () => {
    expect(parsePingSummary("")).toBeNull();
    expect(parsePingSummary("ping: cannot resolve 1.1.1.1")).toBeNull();
  });
});
