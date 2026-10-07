import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { Detail } from "@raycast/api";
import {
  renderCommand,
  waitFor,
  assertNoBadSubstrings,
  imageSvg,
} from "./render";
import { SpeedTestRecord } from "../speed-test/types";

const historyMock = vi.fn<() => Promise<SpeedTestRecord[]>>();
vi.mock("../speed-test/history", () => ({
  loadHistory: () => historyMock(),
  saveHistory: vi.fn(),
}));

import SpeedTest from "../speed-test";

const validRecord: SpeedTestRecord = {
  timestamp: Date.now(),
  full: true,
  dlMbps: 138.6,
  ulMbps: 25.2,
  latencyMs: 61.9,
  responsiveness: 183.3,
  dataUsedMB: 172.5,
  interfaceName: "en0",
};

describe("speed-test command", () => {
  beforeEach(() => {
    historyMock.mockReset();
  });

  it("renders the empty state without crashing when no test has ever run", async () => {
    historyMock.mockResolvedValue([]);
    const renderer = await renderCommand(<SpeedTest />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    expect(markdown).toContain("No speed test yet");
    assertNoBadSubstrings(markdown, "speed-test empty state");
  });

  it("renders a valid history without crashing and with real numbers", async () => {
    historyMock.mockResolvedValue([validRecord]);
    const renderer = await renderCommand(<SpeedTest />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    expect(markdown).toContain("138.6");
    expect(imageSvg(markdown, "Speed")).toContain(">DOWNLOAD<");
    const metrics = imageSvg(markdown, "Metrics");
    expect(metrics).toContain(">LATENCY<");
    expect(metrics).toContain(">61.9<");
    expect(metrics).toContain(">183<");
    assertNoBadSubstrings(markdown, "speed-test valid history");
  });

  // The exact bug this harness exists to catch: a corrupt (null-valued)
  // record persisted before parse.ts's fix used to crash `formatValue` on
  // every render, forever. history.ts now filters it on load (see
  // speed-test/history.test.ts), but this proves the *rendered command*
  // survives even if a corrupt record ever reaches it directly.
  it("never throws even if a corrupt null-valued record reaches the renderer", async () => {
    const corrupt = {
      timestamp: Date.now(),
      full: true,
      dlMbps: null,
      ulMbps: null,
      latencyMs: null,
      responsiveness: null,
      dataUsedMB: null,
      interfaceName: "en0",
    } as unknown as SpeedTestRecord;
    historyMock.mockResolvedValue([corrupt, validRecord]);

    const renderer = await renderCommand(<SpeedTest />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    expect(markdown.length).toBeGreaterThan(0);
  });
});
