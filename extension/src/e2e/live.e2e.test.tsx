// Live-mode e2e — only runs with `E2E_LIVE=1` (i.e. `make e2e-live`); a
// plain `make e2e`/`vitest run` skips this whole file. Renders real commands
// against real sources (the actual router, `batt`/`ioreg`, the real argo
// proxy, the real quota fetcher) and writes each one's rendered markdown to
// /tmp/tinycast-e2e/<command>.md for a human to read afterwards. Strictly
// read-only: every mutating Netgear action is out of reach here (see the
// `postForm` guard below), and this never runs `networkQuality` (that costs
// real metered data — speed-test renders whatever's already in history).
//
// The one exception to "hit the real thing": `lib/secrets`'s `getSecret` is
// re-pointed to a Keychain-only lookup (no 1Password `op read` fallback) —
// this repo's own rules forbid `op` calls on some hosts entirely (hangs on a
// biometric prompt nothing can answer), so a live run with no Keychain entry
// cached just sees the same "unavailable" error the real extension would
// show a user who hasn't run `make secrets` yet, rather than risking a hang.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import React from "react";
import { Detail, Grid } from "@raycast/api";
import { renderCommand, waitFor, assertNoBadSubstrings } from "./render";

const LIVE = process.env.E2E_LIVE === "1";
const OUT_DIR = "/tmp/tinycast-e2e";

vi.mock("../lib/secrets", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/secrets")>("../lib/secrets");
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  async function keychainOnly(key: "apiToken" | "netgearPassword") {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", [
        "find-generic-password",
        "-s",
        "tinycast-extensions",
        "-a",
        key,
        "-w",
      ]);
      const value = stdout.trim();
      if (value) return value;
    } catch {
      // fall through to the same error the real chain throws
    }
    throw new actual.SecretUnavailableError(key);
  }

  return { ...actual, getSecret: keychainOnly };
});

function writeOutput(name: string, content: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.md`), content, "utf8");
}

describe.skipIf(!LIVE)("live e2e (E2E_LIVE=1, read-only, real sources)", () => {
  beforeAll(() => {
    mkdirSync(OUT_DIR, { recursive: true });
  });

  it("netgear: real router status only, never a mutating action", async () => {
    const { NetgearClient } = await import("../netgear/client");
    const { CurlNetgearHttp } = await import("../netgear/transport");
    const { statusMarkdown } = await import("../netgear/status-view");
    const { DEFAULT_HOST } = await import("../netgear/session");
    const { environment, getPreferenceValues } = await import("@raycast/api");

    // Real transport, but `postForm` is hard-disabled — this test only
    // ever calls `getStatus()` (a real `get()`), so no legitimate call
    // should reach `postForm` at all; if one ever does (a future code
    // change), this throws instead of touching the router.
    const jarPath = join(environment.supportPath, "netgear-cookies.jar");
    const realTransport = new CurlNetgearHttp(jarPath);
    const guardedTransport = {
      get: (url: string) => realTransport.get(url),
      postForm: () => {
        throw new Error(
          "live e2e: postForm must never be called (status-only, read-only)",
        );
      },
    };
    const host = (
      getPreferenceValues<{ netgearHost?: string }>().netgearHost ||
      DEFAULT_HOST
    ).replace(/\/$/, "");
    const client = new NetgearClient({ host, transport: guardedTransport });

    const status = await client.getStatus();
    const markdown = statusMarkdown(status, false, undefined);
    writeOutput("netgear", markdown);
    assertNoBadSubstrings(markdown, "live netgear");
    expect(markdown.length).toBeGreaterThan(0);
  }, 30_000);

  it("battery: real batt/ioreg", async () => {
    const Battery = (await import("../battery")).default;
    const renderer = await renderCommand(<Battery />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
      { timeoutMs: 15_000 },
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    writeOutput("battery", markdown);
    assertNoBadSubstrings(markdown, "live battery");
    expect(markdown.length).toBeGreaterThan(0);
  }, 30_000);

  it("claude-usage: real quota fetcher + real argo spend", async () => {
    const ClaudeUsage = (await import("../claude-usage")).default;
    const renderer = await renderCommand(<ClaudeUsage />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
      { timeoutMs: 20_000 },
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    writeOutput("claude-usage", markdown);
    assertNoBadSubstrings(markdown, "live claude-usage");
    expect(markdown.length).toBeGreaterThan(0);
  }, 30_000);

  it("hub: every tile's real status, tolerating individual failures", async () => {
    const Hub = (await import("../hub")).default;
    const renderer = await renderCommand(<Hub />);
    await waitFor(() => renderer.root.findAllByType(Grid.Item).length === 7, {
      timeoutMs: 20_000,
    });
    // Tile status text settles asynchronously per-tile after the initial
    // mount — give the slowest source (netgear/argo) a moment, then read
    // whatever every tile landed on.
    await waitFor(() => true, { timeoutMs: 3_000 });
    const summary = renderer.root
      .findAllByType(Grid.Item)
      .map((t) => JSON.stringify({ content: !!t.props.content }))
      .join("\n");
    writeOutput("hub", summary);
    expect(renderer.root.findAllByType(Grid.Item)).toHaveLength(7);
  }, 30_000);

  it("speed-test: history only, never runs networkQuality", async () => {
    const SpeedTest = (await import("../speed-test")).default;
    const renderer = await renderCommand(<SpeedTest />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    writeOutput("speed-test", markdown);
    assertNoBadSubstrings(markdown, "live speed-test");
    expect(markdown.length).toBeGreaterThan(0);
  }, 15_000);
});
