import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetgearClient } from "./client";
import {
  buildModel,
  DataRouterHttp,
  ScriptedNetgearHttp,
  FakePinStore,
  FakeWifiCredsStore,
  FakeWifiRejoiner,
  ICCID,
} from "./test-helpers";
import type { LogEntry } from "../lib/action-log";
import { runWatchdogOnce, WatchdogRunDeps } from "./watchdog-runner";
import {
  loadWatchdogStorage,
  readPendingMarker,
  recordReboot,
  setWatchdogEnabled,
} from "./watchdog-storage";

let dir: string;
let logs: LogEntry[];
let router: DataRouterHttp;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wd-run-"));
  logs = [];
  router = new DataRouterHttp();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(overrides: Partial<WatchdogRunDeps> = {}): WatchdogRunDeps {
  return {
    dir,
    getClient: async () =>
      new NetgearClient({ host: "http://192.168.1.1", transport: router }),
    getPassword: async () => "pw",
    log: (e) => logs.push(e),
    pinStore: new FakePinStore(),
    credsStore: new FakeWifiCredsStore(),
    wifi: new FakeWifiRejoiner(),
    probeInternet: async () => true,
    ...overrides,
  };
}

describe("runWatchdogOnce", () => {
  it("runs one tick and persists the event without logging a routine ok", async () => {
    const event = await runWatchdogOnce(deps());
    expect(event?.kind).toBe("ok");
    expect(loadWatchdogStorage(dir).events[0]?.kind).toBe("ok");
    expect(logs).toEqual([]);
  });

  it("does nothing while paused", async () => {
    setWatchdogEnabled(false, dir);
    expect(await runWatchdogOnce(deps())).toBeNull();
    expect(loadWatchdogStorage(dir).events).toEqual([]);
  });

  it("logs a non-routine event once, to the injected log", async () => {
    const guest = {
      ...buildModel({}),
      session: { userRole: "Guest", secToken: "x" },
    };
    const event = await runWatchdogOnce(
      deps({
        getPassword: async () => null,
        getClient: async () =>
          new NetgearClient({
            host: "http://192.168.1.1",
            transport: new ScriptedNetgearHttp([guest]),
          }),
      }),
    );
    expect(event?.kind).toBe("no-password");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      source: "watchdog",
      action: "no-password",
    });
  });

  it("consumes the UI's reboot marker after the tick that saw it", async () => {
    const at = Date.now();
    recordReboot({ at, source: "ui", iccid: ICCID }, dir);
    await runWatchdogOnce(deps());
    expect(loadWatchdogStorage(dir).state.lastRebootAt).toBe(at);
    expect(readPendingMarker(dir)).toBeNull();
  });

  it("logs a crash outside the tick and rethrows so jobrun records it red", async () => {
    await expect(
      runWatchdogOnce(
        deps({
          getClient: async () => {
            throw new Error("boom");
          },
        }),
      ),
    ).rejects.toThrow("boom");
    expect(logs[0]).toMatchObject({ action: "tick", outcome: "crashed" });
  });
});
