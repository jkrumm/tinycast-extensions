import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { Action, Detail, LocalStorage, environment } from "@raycast/api";
import { existsSync, readFileSync, rmSync } from "fs";
import {
  parseCaptureLog,
  parseVictronReadLog,
  summariseVictronReads,
} from "../van/capture-log";
import { join } from "path";
import {
  renderCommand,
  waitFor,
  assertNoBadSubstrings,
  imageSvg,
} from "./render";
import { HelperResult } from "../van/types";
import { VictronAllResult } from "../van/victron-trends";
import {
  HELPER_BATTERY_BUSY,
  HELPER_BLUETOOTH_OFF,
  HELPER_FULL,
  HELPER_NO_KEY,
  fixtureSamples,
  fixtureVictronAll,
} from "../van/fixtures";
import { saveVanHistory } from "../van/storage";

const readMock =
  vi.fn<() => Promise<{ helper: HelperResult; keyMissing: boolean }>>();
const historyMock =
  vi.fn<
    (opts?: {
      sinceMs?: number;
      history?: boolean;
    }) => Promise<VictronAllResult>
  >();
vi.mock("../van/run", () => ({
  readVan: () => readMock(),
  runVictronAll: (opts?: { sinceMs?: number; history?: boolean }) =>
    historyMock(opts),
}));

import VanPower from "../van-power";

const DATA_URI = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g;

// A base64 blob can contain "NaN" by chance, so assert on the markdown with
// the images stripped and on each decoded SVG separately.
function assertClean(markdown: string, context: string): void {
  assertNoBadSubstrings(markdown.replace(DATA_URI, "data:"), context);
  for (const [, base64] of markdown.matchAll(DATA_URI)) {
    assertNoBadSubstrings(
      Buffer.from(base64, "base64").toString("utf8"),
      `${context} (svg)`,
    );
  }
}

async function open() {
  const renderer = await renderCommand(<VanPower />);
  // Both the live read and the (later) history read must have settled.
  await waitFor(
    () => renderer.root.findByType(Detail).props.isLoading === false,
  );
  return renderer;
}

const markdownOf = (r: Awaited<ReturnType<typeof open>>) =>
  r.root.findByType(Detail).props.markdown as string;

describe("van power command", () => {
  beforeEach(async () => {
    readMock.mockReset();
    historyMock.mockReset();
    historyMock.mockResolvedValue(fixtureVictronAll(Date.now()));
    await LocalStorage.clear();
    for (const file of ["van-log.jsonl", "van-trends.jsonl"]) {
      rmSync(join(environment.supportPath, file), { force: true });
    }
  });

  it("renders just the status panel from a live read — every number once, no table, no warnings", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    const markdown = markdownOf(await open());
    expect(markdown).not.toContain("|"); // nothing left to tabulate
    expect(markdown).not.toContain("⚠️"); // healthy pack: no spread/temperature line
    expect(markdown).not.toContain("Metrics");
    const panel = imageSvg(markdown, "Status");
    for (const expected of [
      "BATTERY",
      "98",
      "SOLAR",
      "19",
      "−12.8 A · empty in ~15h · 13.71 V",
      "Absorption · 30 Wh today",
    ]) {
      expect(panel).toContain(`>${expected}<`);
    }
    assertClean(markdown, "van live read");
  });

  it("headline chart: the battery % estimated from the Victron trends (anchored to our reading) over the solar trend, from the real capture", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    const markdown = markdownOf(await open());
    const chart = imageSvg(markdown, "Charge");
    expect(chart).toContain(">Solar<");
    expect(chart).toContain(
      ">Battery · estimated from charge/discharge, ● measured<",
    );
    expect(chart).toContain("raycast-yellow");
    expect(chart).not.toContain("Battery V");
    expect(chart).toContain("20% low");
    expect(chart).not.toContain("readings so far");
    expect(markdown).not.toContain("readings so far");
    assertClean(markdown, "van charge chart");
  });

  it("shows the Victron's yield bars with its heading — and nothing else from the history", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    const markdown = markdownOf(await open());
    expect(markdown).toMatch(
      /### Solar yield · last 14 days · [\d.]+ kWh in 30 days/,
    );
    expect(markdown).not.toContain("voltage");
    expect(imageSvg(markdown, "Yield")).toContain("avg ");
    expect(markdown.match(DATA_URI)).toHaveLength(3); // panel + charge + yield
    assertClean(markdown, "van with victron history");
  });

  it("starts the history read only after the live read has finished", async () => {
    const order: string[] = [];
    let finishLive: (v: {
      helper: HelperResult;
      keyMissing: boolean;
    }) => void = () => {};
    readMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("live:start");
          finishLive = (v) => {
            order.push("live:end");
            resolve(v);
          };
        }),
    );
    historyMock.mockImplementation(async () => {
      order.push("history:start");
      return fixtureVictronAll(Date.now());
    });
    const rendering = open();
    await waitFor(() => order.includes("live:start"));
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["live:start"]); // history waits
    await act(async () => {
      finishLive({ helper: HELPER_FULL, keyMissing: false });
    });
    await rendering;
    expect(order).toEqual(["live:start", "live:end", "history:start"]);
  });

  it("a failing history read never breaks the view: quiet one-liner, rest intact", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    historyMock.mockRejectedValue(new Error("van-ble exited 1"));
    const markdown = markdownOf(await open());
    expect(markdown).toContain(
      "_Victron history unavailable (van-ble exited 1)_",
    );
    expect(markdown).not.toContain("### Solar yield");
    expect(imageSvg(markdown, "Status")).toContain("−12.8 A");
    assertClean(markdown, "van history failure");
  });

  it("every open tops the Victron cache up incrementally; the daily history is read once", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    await open();
    expect(historyMock).toHaveBeenLastCalledWith({
      sinceMs: undefined,
      history: true,
    });
    await open();
    expect(historyMock).toHaveBeenCalledTimes(2);
    expect(historyMock).toHaveBeenLastCalledWith({
      sinceMs: expect.any(Number),
      history: false,
    });
  });

  it("paints the cached charts on the first frame, before the live read finishes", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    await open(); // fills the cache
    let finishLive: (v: {
      helper: HelperResult;
      keyMissing: boolean;
    }) => void = () => {};
    readMock.mockImplementation(
      () => new Promise((resolve) => (finishLive = resolve)),
    );
    historyMock.mockClear();
    const renderer = await renderCommand(<VanPower />);
    await waitFor(() => markdownOf(renderer).includes("![Charge"));
    const markdown = markdownOf(renderer);
    expect(markdown).toContain("_Reading Bluetooth… (up to 15 s)_");
    expect(markdown).toContain("![Yield");
    expect(markdown).toMatch(/_Victron data updated .* · reading Victron…_/);
    expect(historyMock).not.toHaveBeenCalled(); // still waiting for the live read
    await act(async () => {
      finishLive({ helper: HELPER_FULL, keyMissing: false });
    });
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );
    expect(historyMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the estimator-tuning logs behind: one capture line per open, the Victron trends at native resolution", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    await open();
    const logPath = join(environment.supportPath, "van-log.jsonl");
    const first = parseCaptureLog(readFileSync(logPath, "utf8"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      ective: { soc: 98, capacityAh: expect.any(Number) },
      victron: { pvW: 19, state: "Absorption" },
    });
    // the open writes its reading at once, provisionally "stale-trends"…
    const raw = readFileSync(logPath, "utf8");
    expect(raw).toContain('"estimateReason":"stale-trends"');
    // …and the Victron read, once it has merged the day's charger current in,
    // replaces that with the real prediction (here: none — no earlier reading)
    expect(raw).toContain('"estimateUpdate"');
    expect(first[0].estimateReason).not.toBe("stale-trends");
    const trendsPath = join(environment.supportPath, "van-trends.jsonl");
    expect(existsSync(trendsPath)).toBe(true);
    expect(readFileSync(trendsPath, "utf8")).toContain('"A":[[');

    // the second open is judged against the first reading + the cached trends
    await open();
    const second = parseCaptureLog(readFileSync(logPath, "utf8"));
    expect(second).toHaveLength(2);
    expect(typeof second[1].estimateAtT).toBe("number");
    // …and every Victron read leaves its start and its outcome next to them
    const reads = summariseVictronReads(
      parseVictronReadLog(readFileSync(logPath, "utf8")),
    );
    expect(reads.map((r) => r.outcome)).toEqual(["done", "done"]);
  });

  it("a Victron read that never lands leaves the reading's live prediction as stale-trends, not a misleading number", async () => {
    historyMock.mockRejectedValue(new Error("victron-connect-failed"));
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    await open();
    const entries = parseCaptureLog(
      readFileSync(join(environment.supportPath, "van-log.jsonl"), "utf8"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      estimateAtT: null,
      estimateReason: "stale-trends",
    });
  });

  it("appends a sample to the stored history on every open", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    await open();
    const stored = JSON.parse(
      (await LocalStorage.getItem<string>("van-history"))!,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ soc: 98, pvW: 19 });
  });

  it("anchors the estimate to many stored readings", async () => {
    await saveVanHistory(fixtureSamples(Date.now() - 3_600_000, 12));
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    const markdown = markdownOf(await open());
    expect(markdown.match(DATA_URI)).toHaveLength(3); // panel + charge + yield
    expect(imageSvg(markdown, "Charge")).toContain(">Battery ·");
    assertClean(markdown, "van with history");
  });

  it("without a Victron trend the charge needs 6+ readings; otherwise no chart and no placeholder", async () => {
    historyMock.mockRejectedValue(new Error("van-ble exited 1"));
    await saveVanHistory(fixtureSamples(Date.now() - 3_600_000, 4));
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    const markdown = markdownOf(await open());
    expect(markdown).not.toContain("![Charge");
    expect(markdown).not.toContain("readings so far");
    expect(markdown.match(DATA_URI)).toHaveLength(1); // the panel only
  });

  it("history without trends still draws the bars; trends without history still draw the chart", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    historyMock.mockResolvedValue({
      ...fixtureVictronAll(Date.now()),
      trends: null,
    });
    let markdown = markdownOf(await open());
    expect(markdown).toContain("![Yield");
    expect(markdown).not.toContain("![Charge"); // 1 own reading, no solar

    await LocalStorage.clear();
    historyMock.mockResolvedValue({
      ...fixtureVictronAll(Date.now()),
      history: { total: null, days: [], errors: [] },
    });
    markdown = markdownOf(await open());
    expect(markdown).not.toContain("![Yield");
    expect(imageSvg(markdown, "Charge")).toContain(">Solar<");
  });

  it("keeps the battery and says the Victron key is missing", async () => {
    readMock.mockResolvedValue({ helper: HELPER_NO_KEY, keyMissing: true });
    const markdown = markdownOf(await open());
    expect(markdown).toContain("Victron key missing — run `make secrets`");
    expect(imageSvg(markdown, "Status")).toContain("−12.8 A");
    expect(imageSvg(markdown, "Status")).not.toContain(">SOLAR<");
    assertClean(markdown, "van without key");
  });

  it("shows the solar side when the BMS is busy with the phone app", async () => {
    readMock.mockResolvedValue({
      helper: { ...HELPER_BATTERY_BUSY, victron: HELPER_FULL.victron },
      keyMissing: false,
    });
    const markdown = markdownOf(await open());
    expect(markdown).toContain("phone app");
    expect(imageSvg(markdown, "Status")).toContain(">19<");
    expect(imageSvg(markdown, "Status")).not.toContain(">BATTERY<");
    assertClean(markdown, "van bms busy");
  });

  it("shows an error, not a blank pane, when nothing could be read", async () => {
    readMock.mockResolvedValue({
      helper: HELPER_BLUETOOTH_OFF,
      keyMissing: false,
    });
    const markdown = markdownOf(await open());
    expect(markdown).toContain("Bluetooth is off.");
    assertClean(markdown, "van bluetooth off");
  });

  it("keeps the last reading under an offline banner when a refresh fails", async () => {
    readMock.mockResolvedValueOnce({ helper: HELPER_FULL, keyMissing: false });
    const renderer = await open();

    readMock.mockResolvedValue({
      helper: HELPER_BLUETOOTH_OFF,
      keyMissing: false,
    });
    const refresh = renderer.root
      .findAllByType(Action)
      .find((a) => a.props.title === "Refresh")!;
    await act(async () => {
      refresh.props.onAction();
    });
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );

    const markdown = markdownOf(renderer);
    expect(markdown).toContain("Van not reachable");
    expect(imageSvg(markdown, "Status")).toContain("−12.8 A"); // cached reading
    assertClean(markdown, "van offline banner");
  });
});
