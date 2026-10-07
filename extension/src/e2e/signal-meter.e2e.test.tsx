import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { Detail } from "@raycast/api";
import {
  renderCommand,
  waitFor,
  assertNoBadSubstrings,
  imageSvg,
} from "./render";

// The real ping sends ICMP to the public internet — a fixture render must be
// deterministic and offline, so the result is scripted per test.
const ping = vi.hoisted(() => ({
  result: { lossPercent: 7.5, avgMs: 320.4 } as {
    lossPercent: number;
    avgMs: number | null;
  } | null,
}));
vi.mock("../netgear/ping", () => ({ runPing: async () => ping.result }));

// Read-only fixture transport, same as netgear.e2e.test.tsx: `postForm` throws
// unconditionally, the meter only ever GETs the model.
const router = vi.hoisted(() => ({ fail: false, reads: 0 }));
vi.mock("../netgear/session", async () => {
  const { NetgearClient } = await import("../netgear/client");
  type NetgearHttp = import("../netgear/types").NetgearHttp;
  type NetgearHttpResponse = import("../netgear/types").NetgearHttpResponse;
  class ReadOnlyFixtureTransport implements NetgearHttp {
    async get(): Promise<NetgearHttpResponse> {
      router.reads++;
      if (router.fail) throw new Error("curl exited 7: Failed to connect");
      const { readFileSync } = await import("fs");
      const { join } = await import("path");
      const body = readFileSync(
        join(__dirname, "../netgear/fixtures/model-admin.fixture.json"),
        "utf8",
      );
      return { status: 200, body };
    }
    async postForm(): Promise<NetgearHttpResponse> {
      throw new Error(
        "ReadOnlyFixtureTransport: postForm must never be called from a fixture render test",
      );
    }
  }
  return {
    getClient: async () =>
      new NetgearClient({
        host: "http://192.168.1.1",
        transport: new ReadOnlyFixtureTransport(),
      }),
  };
});

import { SignalMeter } from "../netgear/signal-meter";

describe("signal meter (fixture, read-only)", () => {
  beforeEach(() => {
    router.fail = false;
    router.reads = 0;
    ping.result = { lossPercent: 7.5, avgMs: 320.4 };
  });

  async function renderFirstReading() {
    const renderer = await renderCommand(<SignalMeter />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
      { timeoutMs: 10_000 },
    );
    return renderer;
  }

  it("renders the verdict, the panel and the table from the fixture", async () => {
    const renderer = await renderFirstReading();
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    // The meter polls on a 2 s interval — never leave it running past the test.
    renderer.unmount();
    expect(markdown.startsWith("# Fair — SINR 4 dB")).toBe(true);
    expect(imageSvg(markdown, "Signal")).toContain(">SINR<");
    expect(markdown).toContain("| RSRP | −98 dBm · Fair |");
    expect(markdown).toContain("| Cell ID | 25480193 |");
    expect(markdown).toContain("| CA secondary cells | 1 |");
    expect(markdown).toContain("| Ping | 320 ms avg · 7.5% loss |");
    expect(markdown).toContain("| Best SINR | 4 dB · just now |");
    assertNoBadSubstrings(markdown, "signal meter fixture");
  });

  it("renders when ping produced no summary", async () => {
    ping.result = null;
    const renderer = await renderFirstReading();
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    renderer.unmount();
    expect(markdown).toContain("| Ping | — |");
    assertNoBadSubstrings(markdown, "signal meter fixture, no ping");
  });

  it("explains an unreachable router instead of crashing", async () => {
    router.fail = true;
    const renderer = await renderCommand(<SignalMeter />);
    await waitFor(
      () =>
        (renderer.root.findByType(Detail).props.markdown as string).includes(
          "No reading yet",
        ),
      { timeoutMs: 10_000 },
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    renderer.unmount();
    expect(markdown).toContain("Router not reachable");
    assertNoBadSubstrings(markdown, "signal meter fixture, unreachable");
  });

  it("stops polling once unmounted", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const renderer = await renderFirstReading();
      const afterFirstReading = router.reads;
      renderer.unmount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(router.reads).toBe(afterFirstReading);
    } finally {
      vi.useRealTimers();
    }
  });
});
