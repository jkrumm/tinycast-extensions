import { describe, expect, it } from "vitest";
import { BASE_STATUS } from "./test-helpers";
import {
  EMPTY_HISTORY,
  MAX_SAMPLES,
  SignalHistory,
  pushSample,
  signalMarkdown,
  signalRow,
  tableRows,
  toSample,
} from "./signal-view";

const PING = { lossPercent: 7.5, avgMs: 320.4 };

function sampleAt(at: number, sinr: number | null) {
  return toSample({ ...BASE_STATUS, sinr }, PING, at);
}

describe("toSample", () => {
  it("keeps the radio fields and the ping result", () => {
    expect(toSample(BASE_STATUS, PING, 1000)).toEqual({
      at: 1000,
      sinr: 4,
      rsrp: -98,
      rsrq: -12,
      rssi: -68,
      band: "LTE B7",
      registered: true,
      cellId: "25480193",
      caSecondaryCells: 1,
      txLevel: 10,
      pingAvgMs: 320.4,
      lossPercent: 7.5,
    });
  });

  it("has no ping numbers when ping gave no summary", () => {
    const sample = toSample(BASE_STATUS, null, 1000);
    expect(sample.pingAvgMs).toBeNull();
    expect(sample.lossPercent).toBeNull();
  });
});

describe("pushSample", () => {
  it("keeps only the last MAX_SAMPLES readings", () => {
    let history: SignalHistory = EMPTY_HISTORY;
    for (let i = 0; i < MAX_SAMPLES + 15; i++) {
      history = pushSample(history, sampleAt(i * 2000, 4));
    }
    expect(history.samples).toHaveLength(MAX_SAMPLES);
    expect(history.samples[0].at).toBe(15 * 2000);
  });

  it("remembers the best SINR even after it scrolls out of the window", () => {
    let history = pushSample(EMPTY_HISTORY, sampleAt(0, 12));
    for (let i = 1; i <= MAX_SAMPLES + 1; i++) {
      history = pushSample(history, sampleAt(i * 2000, 3));
    }
    expect(history.best).toEqual({ sinr: 12, at: 0 });
    expect(history.samples.every((s) => s.sinr === 3)).toBe(true);
  });

  it("refreshes the best's time on a tie, and ignores unreadable SINR", () => {
    let history = pushSample(EMPTY_HISTORY, sampleAt(0, 9));
    history = pushSample(history, sampleAt(2000, null));
    expect(history.best).toEqual({ sinr: 9, at: 0 });
    history = pushSample(history, sampleAt(4000, 9));
    expect(history.best).toEqual({ sinr: 9, at: 4000 });
  });

  it("does not mutate the previous history", () => {
    const next = pushSample(EMPTY_HISTORY, sampleAt(0, 5));
    expect(EMPTY_HISTORY.samples).toEqual([]);
    expect(next.samples).toHaveLength(1);
  });
});

describe("signalRow", () => {
  it("is the compact verdict line for the main view", () => {
    expect(signalRow(BASE_STATUS)).toBe("Fair · SINR 4 dB · RSRP −98");
  });

  it("is null when the router reports no signal", () => {
    expect(
      signalRow({ ...BASE_STATUS, sinr: null, rsrp: null, rsrq: null }),
    ).toBeNull();
  });

  it("works with only one of the two", () => {
    expect(signalRow({ ...BASE_STATUS, rsrp: null })).toBe("Fair · SINR 4 dB");
    expect(signalRow({ ...BASE_STATUS, sinr: null, rsrp: -85 })).toBe(
      "Good · RSRP −85",
    );
  });
});

describe("tableRows", () => {
  it("covers every metric with units, ratings and the best-SINR age", () => {
    const sample = sampleAt(60_000, 4);
    const rows = Object.fromEntries(tableRows(sample, { sinr: 9, at: 48_000 }));
    expect(rows).toEqual({
      SINR: "4 dB · Fair",
      RSRP: "−98 dBm · Fair",
      RSRQ: "−12 dB · Good",
      RSSI: "−68 dBm",
      Band: "LTE B7",
      "Cell ID": "25480193",
      "CA secondary cells": "1",
      "Tx power": "10 dBm",
      Ping: "320 ms avg · 7.5% loss",
      "Best SINR": "9 dB · 12 s ago",
    });
  });

  it("shows dashes for what the router or ping did not report", () => {
    const sample = toSample(
      {
        ...BASE_STATUS,
        sinr: null,
        rsrp: null,
        rsrq: null,
        rssi: null,
        cellId: null,
        caSecondaryCells: null,
        band: "",
      },
      null,
      0,
    );
    const rows = Object.fromEntries(tableRows(sample, null));
    expect(rows.SINR).toBe("—");
    expect(rows["Cell ID"]).toBe("—");
    expect(rows["CA secondary cells"]).toBe("—");
    expect(rows.Band).toBe("—");
    expect(rows.Ping).toBe("—");
    expect(rows["Best SINR"]).toBe("—");
  });

  it("says no reply when every ping was lost", () => {
    const sample = toSample(BASE_STATUS, { lossPercent: 100, avgMs: null }, 0);
    expect(Object.fromEntries(tableRows(sample, null)).Ping).toBe(
      "no reply · 100% loss",
    );
  });
});

describe("signalMarkdown", () => {
  function history(count: number, sinr: number | null = 4): SignalHistory {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < count; i++) h = pushSample(h, sampleAt(i * 2000, sinr));
    return h;
  }

  it("leads with the verdict and SINR, then the panel, trend, table and tip", () => {
    const markdown = signalMarkdown({ history: history(5) });
    expect(markdown.startsWith("# Fair — SINR 4 dB\n")).toBe(true);
    expect(markdown).toContain("![Signal](data:image/svg+xml;base64,");
    expect(markdown).toContain("![Trend](data:image/svg+xml;base64,");
    expect(markdown).toContain("| CA secondary cells | 1 |");
    expect(markdown).toContain("hold each spot ~10 s");
  });

  it("draws no trend before there are two readings", () => {
    expect(signalMarkdown({ history: history(1) })).not.toContain("![Trend]");
  });

  it("falls back to RSRP in the headline without SINR", () => {
    const h = pushSample(EMPTY_HISTORY, {
      ...sampleAt(0, null),
      rsrp: -102,
    });
    expect(signalMarkdown({ history: h }).split("\n")[0]).toBe(
      "# Poor — RSRP −102 dBm",
    );
  });

  it("says the router is not registered, whatever the signal looks like", () => {
    const h = pushSample(
      EMPTY_HISTORY,
      toSample({ ...BASE_STATUS, registered: false, sinr: 18 }, PING, 0),
    );
    expect(signalMarkdown({ history: h }).split("\n")[0]).toBe(
      "# Not registered (limited service) — SINR 18 dB",
    );
    const noReading = pushSample(
      EMPTY_HISTORY,
      toSample(
        { ...BASE_STATUS, registered: false, sinr: null, rsrp: null },
        PING,
        0,
      ),
    );
    expect(signalMarkdown({ history: noReading }).split("\n")[0]).toBe(
      "# Not registered (limited service)",
    );
  });

  it("says so when the router reports no LTE signal at all", () => {
    const h = pushSample(EMPTY_HISTORY, {
      ...sampleAt(0, null),
      rsrp: null,
      rsrq: null,
    });
    expect(signalMarkdown({ history: h })).toContain("# No LTE signal reading");
  });

  it("keeps the last reading under a warning when a refresh fails", () => {
    const markdown = signalMarkdown({
      history: history(3),
      error: "Router not reachable.",
    });
    expect(markdown).toContain("# Fair — SINR 4 dB");
    expect(markdown).toContain("> ⚠️ Router not reachable. Showing the last");
  });

  it("explains an unreachable router before the first reading", () => {
    expect(
      signalMarkdown({
        history: EMPTY_HISTORY,
        error: "Router not reachable.",
      }),
    ).toContain("# No reading yet");
    expect(signalMarkdown({ history: EMPTY_HISTORY })).toBe("Loading…");
  });
});
