import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { Detail } from "@raycast/api";
import {
  renderCommand,
  waitFor,
  assertNoBadSubstrings,
  imageSvg,
} from "./render";
import type { SimPinStore } from "../netgear/pin-store";

// The real probe shells out to curl against the public internet — a fixture
// render must be deterministic and offline, so the result is scripted per test.
const probe = vi.hoisted(() => ({ result: true as boolean | Error }));
vi.mock("../netgear/internet-probe", () => ({
  probeInternet: async () => {
    if (probe.result instanceof Error) throw probe.result;
    return probe.result;
  },
}));

// Read-only fixture transport — `postForm` throws unconditionally: the admin
// fixture's userRole is already "Admin", so `netgear.tsx`'s `loadStatus()`
// never needs to call `login()` (the one legitimate postForm), and nothing
// in a fresh render should ever reach a mutating action. Everything lives
// inside the `vi.mock` factory since it's hoisted above this file's own
// top-level declarations.
vi.mock("../netgear/session", async () => {
  const fakePinStore: SimPinStore = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    take: async () => null,
    getLastIccid: async () => null,
    setLastIccid: async () => {},
  };
  const { NetgearClient } = await import("../netgear/client");
  type NetgearHttp = import("../netgear/types").NetgearHttp;
  type NetgearHttpResponse = import("../netgear/types").NetgearHttpResponse;
  class ReadOnlyFixtureTransport implements NetgearHttp {
    async get(): Promise<NetgearHttpResponse> {
      const { readFileSync } = await import("fs");
      const { join } = await import("path");
      const model = JSON.parse(
        readFileSync(
          join(__dirname, "../netgear/fixtures/model-admin.fixture.json"),
          "utf8",
        ),
      );
      return { status: 200, body: JSON.stringify(model) };
    }
    async postForm(): Promise<NetgearHttpResponse> {
      throw new Error(
        "ReadOnlyFixtureTransport: postForm must never be called from a fixture render test",
      );
    }
  }
  return {
    DEFAULT_HOST: "http://192.168.1.1",
    getClient: async () =>
      new NetgearClient({
        host: "http://192.168.1.1",
        transport: new ReadOnlyFixtureTransport(),
      }),
    getPassword: async () => null,
    pinStore: fakePinStore,
    withAdmin: async () => {},
    // A path that never exists: no lock holder, ever, in a fixture render.
    actionLockPath: () => "/tmp/tinycast-e2e/netgear-action.lock.absent",
    withUiActionLock: async (_opts: unknown, fn: () => Promise<unknown>) =>
      fn(),
    waitMessage: () => "",
  };
});

// The view drives watchdog ticks while mounted — a fixture render must never
// run one (it would take locks and write storage), so the runner is inert.
vi.mock("../netgear/watchdog-runner", () => ({
  runWatchdogOnce: async () => null,
}));

import Netgear from "../netgear";

describe("netgear command (fixture, read-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probe.result = true;
  });

  async function renderLoaded() {
    const renderer = await renderCommand(<Netgear />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
      { timeoutMs: 10_000 },
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    // The view polls on a 10 s interval — never leave it running past the test.
    renderer.unmount();
    return markdown;
  }

  it("renders the admin-fixture status without crashing or mutating the router", async () => {
    const markdown = await renderLoaded();
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).toContain("Internet · internet.fake");
    expect(markdown).toContain("2 unread");
    expect(imageSvg(markdown, "Metrics")).toContain(">Online<");
    expect(markdown).not.toContain("No internet");
    expect(markdown).toContain("running here while this view is open");
    expect(markdown).toContain("Press Esc to close");
    assertNoBadSubstrings(markdown, "netgear fixture status");
  });

  it("flags a Connected router whose internet check fails", async () => {
    probe.result = false;
    const markdown = await renderLoaded();
    expect(markdown).toContain("· No internet");
    expect(imageSvg(markdown, "Metrics")).toContain(">Offline<");
    assertNoBadSubstrings(markdown, "netgear fixture no-internet");
  });

  it("shows an unknown internet state when the probe itself fails", async () => {
    probe.result = new Error("curl missing");
    const markdown = await renderLoaded();
    expect(imageSvg(markdown, "Metrics")).not.toContain(">Online<");
    expect(imageSvg(markdown, "Metrics")).not.toContain(">Offline<");
    expect(markdown).not.toContain("No internet");
    assertNoBadSubstrings(markdown, "netgear fixture unknown-internet");
  });
});
