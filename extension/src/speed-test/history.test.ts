import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const store = new Map<string, string>();

vi.mock("@raycast/api", () => ({
  LocalStorage: {
    getItem: vi.fn((key: string) =>
      Promise.resolve(store.has(key) ? store.get(key) : undefined),
    ),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  },
}));

import { loadHistory, saveHistory } from "./history";
import { SpeedTestRecord } from "./types";

// The exact shape that leaked into LocalStorage before parse.ts's fix: a
// full test run while offline saved a record with every measurement null,
// which crashed the sparkline's formatValue on every subsequent open.
const corruptRecord = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures/corrupt-null-record.fixture.json"),
    "utf8",
  ),
) as SpeedTestRecord;

const validRecord: SpeedTestRecord = {
  timestamp: 2000,
  full: false,
  dlMbps: 65.4,
  ulMbps: null,
  latencyMs: 12.3,
  responsiveness: null,
  dataUsedMB: 15.2,
  interfaceName: "en0",
};

describe("loadHistory", () => {
  beforeEach(() => {
    store.clear();
  });

  it("returns an empty array when nothing is stored", async () => {
    expect(await loadHistory()).toEqual([]);
  });

  it("self-heals a previously-persisted corrupt (null dlMbps) record", async () => {
    store.set(
      "speed-test-history",
      JSON.stringify([corruptRecord, validRecord]),
    );
    expect(await loadHistory()).toEqual([validRecord]);
  });

  it("drops a non-array payload defensively", async () => {
    store.set("speed-test-history", JSON.stringify({ not: "an array" }));
    expect(await loadHistory()).toEqual([]);
  });

  it("round-trips a saved, valid history unchanged", async () => {
    await saveHistory([validRecord]);
    expect(await loadHistory()).toEqual([validRecord]);
  });
});
