import { describe, it, expect } from "vitest";
import { NetgearClient } from "./client";
import { RouterModel } from "./types";
import {
  ICCID,
  buildModel,
  ScriptedNetgearHttp,
  DataRouterHttp,
  FakePinStore,
  FakeWifiCredsStore,
  FakeWifiRejoiner,
  fakeClock,
  BASE_STATUS,
  REJECTED_BODY,
  SUCCESS_BODY,
} from "./test-helpers";
import {
  appendWatchdogEvent,
  migrateWatchdogState,
  nextLowBatteryNotice,
  runWatchdogTick,
  formatSubtitle,
  breadcrumbMessage,
  scaledTimeouts,
  reconnectBackoffMs,
  incidentContext,
  CONFIRM_DELAY_MS,
  CONFIRM_COST_MS,
  PROBE_TIMEOUT_MS,
  INITIAL_WATCHDOG_STATE,
  REBOOT_COOLDOWN_MS,
  REBOOT_RECOVERY_WINDOW_MS,
  RebootMarker,
  WatchdogState,
  DEFAULT_WATCHDOG_BUDGET_MS,
  WatchdogActionKind,
  WatchdogEvent,
} from "./watchdog";

// Budget too short for the in-tick internet confirm (CONFIRM_COST_MS + 25s
// action floor) — the tick falls back to counting failed probes across ticks.
const CROSS_TICK_BUDGET_MS = 30_000;

function guestModel(): RouterModel {
  return { ...buildModel({}), session: { userRole: "Guest", secToken: "x" } };
}

function client(script: ConstructorParameters<typeof ScriptedNetgearHttp>[0]) {
  return new NetgearClient({
    host: "http://192.168.1.1",
    transport: new ScriptedNetgearHttp(script),
  });
}

// Unreachable on the first read, answering once the Mac has rejoined the
// router's Wi-Fi — a rejoin only counts if the router comes back.
function clientBackAfterRejoin() {
  return client([new Error("curl exited 7"), buildModel({})]);
}

describe("runWatchdogTick", () => {
  it("is idle when the router is unreachable — never tries to join Wi-Fi", async () => {
    const result = await runWatchdogTick({
      client: client([new Error("ECONNREFUSED")]),
      password: null,
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("idle");
    expect(result.state).toEqual(INITIAL_WATCHDOG_STATE);
  });

  it("reports no-password when the session is Guest and no password is configured", async () => {
    const result = await runWatchdogTick({
      client: client([guestModel()]),
      password: null,
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("no-password");
  });

  it("logs in with the configured password and proceeds", async () => {
    const connected = buildModel({ connection: "Connected" });
    const result = await runWatchdogTick({
      client: client([guestModel(), connected]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("ok");
  });

  it("needs-pin when the SIM is Locked with no saved PIN", async () => {
    const locked = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const result = await runWatchdogTick({
      client: client([locked]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("needs-pin");
  });

  it("auto-unlocks a Locked SIM with a saved PIN, then ensures connected", async () => {
    const locked = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const ready = buildModel({
      sim: {
        status: "Ready",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
      connection: "Connected",
    });
    const script = [
      locked, // 0: watchdog's initial getStatus()
      locked, // 1: unlockSim's "before" getStatus()
      locked, // 2: enterSimPin() -> action() -> getModel()
      ready, // 3: unlockSim's pollUntil(Ready) -> done
      ready, // 4: ensureConnected's "already connected?" check -> done
    ];
    const pinStore = new FakePinStore({ [ICCID]: "4321" });
    const clock = fakeClock(2000);

    const result = await runWatchdogTick({
      client: client(script),
      password: "s3cr3t",
      pinStore,
      state: {
        internetFailures: 3,
        lastReconnectAt: null,
        reconnectStreak: 0,
        lastRejoinAttemptAt: null,
        lastRoamingAttemptAt: null,
        stuckStreak: 0,
        dataToggledAt: null,
        lastRebootAt: null,
        lastBattery: null,
        lowBatteryNoticeLevel: null,
        batteryEmptyAt: null,
        noServiceSince: null,
        lastNoServiceRebootAt: null,
        noServiceRebootCount: 0,
        reboot: null,
      },
      probeInternet: async () => true,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.event.kind).toBe("unlocked");
    expect(result.state.internetFailures).toBe(0);
  });

  it("reports sim-problem for a Blocked SIM, taking no action", async () => {
    const blocked = buildModel({
      sim: {
        status: "Blocked",
        pin: { mode: "Enabled", retry: 0 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const transport = new ScriptedNetgearHttp([blocked]);
    const result = await runWatchdogTick({
      client: new NetgearClient({ host: "http://192.168.1.1", transport }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("sim-problem");
    expect(result.event.message).toContain("Blocked");
    expect(transport.postCalls).toHaveLength(0);
  });

  it("connects when Ready but not Connected", async () => {
    const disconnected = buildModel({ connection: "Disconnected" });
    const connected = buildModel({ connection: "Connected" });
    const result = await runWatchdogTick({
      client: client([disconnected, connected]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("connected");
    expect(result.state.internetFailures).toBe(0);
  });

  it("reports connect-failed when the router keeps rejecting connect()", async () => {
    const disconnected = buildModel({ connection: "Disconnected" });
    class RejectConnect extends ScriptedNetgearHttp {
      async postForm(): Promise<{ status: number; body: string }> {
        return { status: 200, body: '{ "success": false }' };
      }
    }
    const transport = new RejectConnect([disconnected]);
    const clock = fakeClock(30_000);
    const result = await runWatchdogTick({
      client: new NetgearClient({ host: "http://192.168.1.1", transport }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.event.kind).toBe("connect-failed");
  });

  it("is ok and resets the failure counter when the internet probe succeeds", async () => {
    const connected = buildModel({ connection: "Connected" });
    const result = await runWatchdogTick({
      client: client([connected]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: {
        internetFailures: 1,
        lastReconnectAt: 1000,
        reconnectStreak: 2,
        lastRejoinAttemptAt: null,
        lastRoamingAttemptAt: null,
        stuckStreak: 0,
        dataToggledAt: null,
        lastRebootAt: null,
        lastBattery: null,
        lowBatteryNoticeLevel: null,
        batteryEmptyAt: null,
        noServiceSince: null,
        lastNoServiceRebootAt: null,
        noServiceRebootCount: 0,
        reboot: null,
      },
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("ok");
    expect(result.state).toEqual({
      internetFailures: 0,
      lastReconnectAt: 1000,
      reconnectStreak: 0,
      lastRejoinAttemptAt: null,
      lastRoamingAttemptAt: null,
      stuckStreak: 0,
      dataToggledAt: null,
      lastRebootAt: null,
      lastBattery: { level: 80, charging: true, at: expect.any(Number) },
      lowBatteryNoticeLevel: null,
      batteryEmptyAt: null,
      noServiceSince: null,
      lastNoServiceRebootAt: null,
      noServiceRebootCount: 0,
      reboot: null,
    });
  });

  it("counts one failed probe without reconnecting", async () => {
    const connected = buildModel({ connection: "Connected" });
    const result = await runWatchdogTick({
      client: client([connected]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => false,
      budgetMs: CROSS_TICK_BUDGET_MS,
    });
    expect(result.event.kind).toBe("probe-failed");
    expect(result.state.internetFailures).toBe(1);
  });

  it("reconnects after two consecutive failed probes", async () => {
    const connected = buildModel({ connection: "Connected" });
    const disconnected = buildModel({ connection: "Disconnected" });
    const script = [
      connected, // 0: watchdog's initial getStatus() — Connected, falls to the probe
      connected, // 1: reconnect(): initial state read
      connected, // 2: reconnect(): disconnect() -> action() -> getModel()
      disconnected, // 3: reconnect(): pollUntil(Disconnected) — done
      disconnected, // 4: reconnect(): connect() -> action() -> getModel()
      connected, // 5: reconnect(): pollUntil(Connected) — done
    ];
    const clock = fakeClock(1000);

    const result = await runWatchdogTick({
      client: client(script),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: {
        internetFailures: 1,
        lastReconnectAt: null,
        reconnectStreak: 0,
        lastRejoinAttemptAt: null,
        lastRoamingAttemptAt: null,
        stuckStreak: 0,
        dataToggledAt: null,
        lastRebootAt: null,
        lastBattery: null,
        lowBatteryNoticeLevel: null,
        batteryEmptyAt: null,
        noServiceSince: null,
        lastNoServiceRebootAt: null,
        noServiceRebootCount: 0,
        reboot: null,
      },
      probeInternet: async () => false,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.event.kind).toBe("reconnected");
    expect(result.state.internetFailures).toBe(0);
    expect(result.state.lastReconnectAt).not.toBeNull();
    expect(result.state.reconnectStreak).toBe(1);
  });

  it("backs off from reconnecting within the streak's backoff of the last attempt", async () => {
    const connected = buildModel({ connection: "Connected" });
    const clock = fakeClock(1000);
    const result = await runWatchdogTick({
      client: client([connected]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: {
        internetFailures: 1,
        lastReconnectAt: 0,
        reconnectStreak: 1,
        lastRejoinAttemptAt: null,
        lastRoamingAttemptAt: null,
        stuckStreak: 0,
        dataToggledAt: null,
        lastRebootAt: null,
        lastBattery: null,
        lowBatteryNoticeLevel: null,
        batteryEmptyAt: null,
        noServiceSince: null,
        lastNoServiceRebootAt: null,
        noServiceRebootCount: 0,
        reboot: null,
      },
      probeInternet: async () => false,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.event.kind).toBe("probe-failed");
    expect(result.event.message).toMatch(/next reconnect after/);
  });

  describe("escalating reconnect backoff", () => {
    it("reconnectBackoffMs: 2 min, 5 min, then 10 min from the 3rd streak on", () => {
      expect(reconnectBackoffMs(0)).toBe(0);
      expect(reconnectBackoffMs(1)).toBe(2 * 60_000);
      expect(reconnectBackoffMs(2)).toBe(5 * 60_000);
      expect(reconnectBackoffMs(3)).toBe(10 * 60_000);
      expect(reconnectBackoffMs(9)).toBe(10 * 60_000);
    });

    async function tickAt(opts: { streak: number; sinceReconnectMs: number }) {
      const connected = buildModel({ connection: "Connected" });
      const disconnected = buildModel({ connection: "Disconnected" });
      const t = 1_000_000;
      return runWatchdogTick({
        client: client([
          connected, // watchdog's initial getStatus()
          connected, // reconnect(): initial state read
          connected, // disconnect() token fetch
          disconnected, // pollUntil(Disconnected)
          disconnected, // connect() token fetch
          connected, // pollUntil(Connected)
        ]),
        password: "s3cr3t",
        pinStore: new FakePinStore(),
        state: {
          internetFailures: 1,
          lastReconnectAt: t - opts.sinceReconnectMs,
          reconnectStreak: opts.streak,
          lastRejoinAttemptAt: null,
          lastRoamingAttemptAt: null,
          stuckStreak: 0,
          dataToggledAt: null,
          lastRebootAt: null,
          lastBattery: null,
          lowBatteryNoticeLevel: null,
          batteryEmptyAt: null,
          noServiceSince: null,
          lastNoServiceRebootAt: null,
          noServiceRebootCount: 0,
          reboot: null,
        },
        probeInternet: async () => false,
        now: () => t,
        sleep: async () => {},
      });
    }

    it("reconnects again 2 min after the 1st reconnect", async () => {
      const early = await tickAt({ streak: 1, sinceReconnectMs: 119_000 });
      expect(early.event.kind).toBe("probe-failed");
      const due = await tickAt({ streak: 1, sinceReconnectMs: 120_000 });
      expect(due.event.kind).toBe("reconnected");
      expect(due.state.reconnectStreak).toBe(2);
    });

    it("waits 5 min after the 2nd and 10 min after the 3rd", async () => {
      expect(
        (await tickAt({ streak: 2, sinceReconnectMs: 4 * 60_000 })).event.kind,
      ).toBe("probe-failed");
      expect(
        (await tickAt({ streak: 2, sinceReconnectMs: 5 * 60_000 })).event.kind,
      ).toBe("reconnected");
      expect(
        (await tickAt({ streak: 3, sinceReconnectMs: 9 * 60_000 })).event.kind,
      ).toBe("probe-failed");
      const due = await tickAt({ streak: 3, sinceReconnectMs: 10 * 60_000 });
      expect(due.event.kind).toBe("reconnected");
      expect(due.state.reconnectStreak).toBe(4);
    });

    it("counts a failed reconnect toward the streak", async () => {
      const connected = buildModel({ connection: "Connected" });
      class RejectAll extends ScriptedNetgearHttp {
        async postForm(): Promise<{ status: number; body: string }> {
          return { status: 200, body: '{ "success": false }' };
        }
      }
      const clock = fakeClock(30_000);
      const result = await runWatchdogTick({
        client: new NetgearClient({
          host: "http://192.168.1.1",
          transport: new RejectAll([connected]),
        }),
        password: "s3cr3t",
        pinStore: new FakePinStore(),
        state: { ...INITIAL_WATCHDOG_STATE, internetFailures: 1 },
        probeInternet: async () => false,
        now: clock.now,
        sleep: clock.sleep,
      });
      expect(result.event.kind).toBe("reconnect-failed");
      expect(result.state.reconnectStreak).toBe(1);
    });
  });

  it("reports reconnect-failed without throwing when reconnect() itself fails", async () => {
    const connected = buildModel({ connection: "Connected" });
    class RejectAll extends ScriptedNetgearHttp {
      async postForm(): Promise<{ status: number; body: string }> {
        return { status: 200, body: '{ "success": false }' };
      }
    }
    const transport = new RejectAll([connected]);
    const clock = fakeClock(30_000);
    const result = await runWatchdogTick({
      client: new NetgearClient({ host: "http://192.168.1.1", transport }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: {
        internetFailures: 1,
        lastReconnectAt: null,
        reconnectStreak: 0,
        lastRejoinAttemptAt: null,
        lastRoamingAttemptAt: null,
        stuckStreak: 0,
        dataToggledAt: null,
        lastRebootAt: null,
        lastBattery: null,
        lowBatteryNoticeLevel: null,
        batteryEmptyAt: null,
        noServiceSince: null,
        lastNoServiceRebootAt: null,
        noServiceRebootCount: 0,
        reboot: null,
      },
      probeInternet: async () => false,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.event.kind).toBe("reconnect-failed");
    expect(result.state.lastReconnectAt).not.toBeNull();
  });

  // Live 2026-10-07 18:12: the Mac lost the router's Wi-Fi mid-reconnect and
  // the tick counted it as a stuck mobile connection; the next tick then
  // tried the data toggle on a router it could not reach.
  it("treats losing the router mid-reconnect as unreachable, not stuck", async () => {
    const connected = buildModel({ connection: "Connected" });
    class LanDrops extends ScriptedNetgearHttp {
      async postForm(): Promise<{ status: number; body: string }> {
        throw new Error("curl exited 7: Failed to connect to 192.168.1.1");
      }
    }
    const transport = new LanDrops([connected]);
    const clock = fakeClock(30_000);
    const result = await runWatchdogTick({
      client: new NetgearClient({ host: "http://192.168.1.1", transport }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: { ...INITIAL_WATCHDOG_STATE, internetFailures: 1 },
      probeInternet: async () => false,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.event.kind).toBe("idle");
    expect(result.event.message).toBe("Router not reachable");
    expect(result.event.detail).toMatch(/curl exited 7/);
    expect(result.state.stuckStreak).toBe(0);
  });

  it("never throws: a broken pin lookup during auto-unlock resolves to needs-pin", async () => {
    // autoUnlockIfPossible only ever throws for a PIN that was actually
    // tried and rejected (flows.ts) — the watchdog treats that the same as
    // "no PIN available": manual entry is needed either way, and the
    // one-attempt budget is already spent.
    class ThrowingPinStore extends FakePinStore {
      async getLastIccid(): Promise<string | null> {
        throw new Error("keychain exploded");
      }
    }
    const throwingPinStore = new ThrowingPinStore();
    const locked = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: "",
      },
    });
    const result = await runWatchdogTick({
      client: client([locked]),
      password: "s3cr3t",
      pinStore: throwingPinStore,
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("needs-pin");
  });

  it("resolves to an error event instead of throwing when login itself fails unexpectedly", async () => {
    const guest = guestModel();
    class ThrowOnPost extends ScriptedNetgearHttp {
      async postForm(): Promise<{ status: number; body: string }> {
        throw new Error("curl exited 7: could not connect");
      }
    }
    const transport = new ThrowOnPost([guest]);
    const result = await runWatchdogTick({
      client: new NetgearClient({ host: "http://192.168.1.1", transport }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("error");
    // Raw transport errors go through describeNetgearError (errors.ts) —
    // the log/subtitle never shows a bare "curl exited 7" to a human.
    expect(result.event.message).toBe(
      "Router not reachable — is this Mac on the router's Wi-Fi?",
    );
    // The raw text survives for the Netgear log / Watchdog Log.
    expect(result.event.detail).toBe("curl exited 7: could not connect");
  });
});

describe("runWatchdogTick — Wi-Fi rejoin rule", () => {
  it("rejoins when the Mac has zero internet at all and creds are stored", async () => {
    const wifi = new FakeWifiRejoiner(true);
    const credsStore = new FakeWifiCredsStore({
      ssid: "FakeNet",
      passphrase: "fake-passphrase",
    });
    const result = await runWatchdogTick({
      client: clientBackAfterRejoin(),
      password: null,
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => false,
      wifi,
      credsStore,
    });
    expect(result.event.kind).toBe("rejoined");
    expect(wifi.rejoinCalls).toEqual([
      { ssid: "FakeNet", passphrase: "fake-passphrase" },
    ]);
    expect(result.state.lastRejoinAttemptAt).not.toBeNull();
  });

  it("never touches Wi-Fi when the Mac still has internet (e.g. home Wi-Fi), even with stored creds", async () => {
    const wifi = new FakeWifiRejoiner(true);
    const credsStore = new FakeWifiCredsStore({
      ssid: "Home",
      passphrase: "x",
    });
    const result = await runWatchdogTick({
      client: client([new Error("curl exited 7")]),
      password: null,
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
      wifi,
      credsStore,
    });
    expect(result.event.kind).toBe("idle");
    expect(wifi.rejoinCalls).toHaveLength(0);
  });

  it("stays idle without stored credentials even with zero internet", async () => {
    const wifi = new FakeWifiRejoiner(true);
    const credsStore = new FakeWifiCredsStore(null);
    const result = await runWatchdogTick({
      client: client([new Error("curl exited 7")]),
      password: null,
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => false,
      wifi,
      credsStore,
    });
    expect(result.event.kind).toBe("idle");
    expect(wifi.rejoinCalls).toHaveLength(0);
  });

  it("backs off from rejoining within 5 minutes of the last attempt", async () => {
    const wifi = new FakeWifiRejoiner(true);
    const credsStore = new FakeWifiCredsStore({
      ssid: "FakeNet",
      passphrase: "x",
    });
    const result = await runWatchdogTick({
      client: client([new Error("curl exited 7")]),
      password: null,
      pinStore: new FakePinStore(),
      state: {
        internetFailures: 0,
        lastReconnectAt: null,
        reconnectStreak: 0,
        lastRejoinAttemptAt: 0,
        lastRoamingAttemptAt: null,
        stuckStreak: 0,
        dataToggledAt: null,
        lastRebootAt: null,
        lastBattery: null,
        lowBatteryNoticeLevel: null,
        batteryEmptyAt: null,
        noServiceSince: null,
        lastNoServiceRebootAt: null,
        noServiceRebootCount: 0,
        reboot: null,
      },
      probeInternet: async () => false,
      wifi,
      credsStore,
      now: () => 60_000, // 1 minute later — inside the 5-minute backoff
    });
    expect(result.event.kind).toBe("idle");
    expect(wifi.rejoinCalls).toHaveLength(0);
  });

  it("reports rejoin-failed without throwing when the Wi-Fi join itself fails", async () => {
    const wifi = new FakeWifiRejoiner(false);
    const credsStore = new FakeWifiCredsStore({
      ssid: "FakeNet",
      passphrase: "x",
    });
    const result = await runWatchdogTick({
      client: client([new Error("curl exited 7")]),
      password: null,
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => false,
      wifi,
      credsStore,
    });
    expect(result.event.kind).toBe("rejoin-failed");
    expect(result.state.lastRejoinAttemptAt).not.toBeNull();
  });
});

describe("runWatchdogTick — data roaming rule", () => {
  function withAutoconnect(autoconnect: string | undefined): RouterModel {
    const model = buildModel({});
    return { ...model, wwan: { ...model.wwan, autoconnect } };
  }

  function wired(script: RouterModel[]) {
    const transport = new ScriptedNetgearHttp(script);
    const netgear = new NetgearClient({
      host: "http://192.168.1.1",
      transport,
    });
    return { transport, netgear };
  }

  it("re-enables roaming once and returns without continuing the tick", async () => {
    const { transport, netgear } = wired([withAutoconnect("HomeNetwork")]);
    const result = await runWatchdogTick({
      client: netgear,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
      now: () => 1_000,
    });
    expect(result.event.kind).toBe("roaming-enabled");
    expect(result.event.message).toBe(
      "Data roaming re-enabled (was HomeNetwork)",
    );
    expect(result.state.lastRoamingAttemptAt).toBe(1_000);
    expect(transport.postCalls).toHaveLength(1);
    expect(transport.postCalls[0].fields["wwan.autoconnect"]).toBe("Always");
  });

  it("does nothing when roaming is already Always", async () => {
    const { transport, netgear } = wired([withAutoconnect("Always")]);
    const result = await runWatchdogTick({
      client: netgear,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("ok");
    expect(transport.postCalls).toHaveLength(0);
  });

  it("never writes on an unreadable autoconnect value", async () => {
    const { transport, netgear } = wired([withAutoconnect(undefined)]);
    const result = await runWatchdogTick({
      client: netgear,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("ok");
    expect(transport.postCalls).toHaveLength(0);
  });

  it("writes before the connection checks, even when disconnected", async () => {
    const model = withAutoconnect("Never");
    model.wwan.connection = "Disconnected";
    const { transport, netgear } = wired([model]);
    const result = await runWatchdogTick({
      client: netgear,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("roaming-enabled");
    expect(transport.postCalls).toHaveLength(1);
  });

  it("backs off for 10 minutes after an attempt, then carries on with the tick", async () => {
    const { transport, netgear } = wired([withAutoconnect("HomeNetwork")]);
    const result = await runWatchdogTick({
      client: netgear,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: { ...INITIAL_WATCHDOG_STATE, lastRoamingAttemptAt: 0 },
      probeInternet: async () => true,
      now: () => 9 * 60_000,
    });
    expect(result.event.kind).toBe("ok");
    expect(transport.postCalls).toHaveLength(0);

    const later = await runWatchdogTick({
      client: wired([withAutoconnect("HomeNetwork")]).netgear,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: { ...INITIAL_WATCHDOG_STATE, lastRoamingAttemptAt: 0 },
      probeInternet: async () => true,
      now: () => 10 * 60_000,
    });
    expect(later.event.kind).toBe("roaming-enabled");
  });

  it("reports a rejected write as an error and still backs off", async () => {
    const transport = new ScriptedNetgearHttp(
      [withAutoconnect("HomeNetwork")],
      [REJECTED_BODY],
    );
    const result = await runWatchdogTick({
      client: new NetgearClient({ host: "http://192.168.1.1", transport }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
      now: () => 5_000,
    });
    expect(result.event.kind).toBe("error");
    expect(result.state.lastRoamingAttemptAt).toBe(5_000);
  });

  it("formats a launcher subtitle with the message and time", () => {
    const subtitle = formatSubtitle({
      at: new Date("2026-10-02T09:05:00").getTime(),
      kind: "roaming-enabled",
      message: "Data roaming re-enabled (was HomeNetwork)",
    });
    expect(subtitle).toMatch(/^Data roaming re-enabled \(was HomeNetwork\) · /);
  });
});

describe("runWatchdogTick — onAction breadcrumbs", () => {
  it("fires unlocking then connecting for a Locked SIM with a saved PIN", async () => {
    const locked = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const ready = buildModel({
      sim: {
        status: "Ready",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
      connection: "Connected",
    });
    const script = [locked, locked, locked, ready, ready];
    const pinStore = new FakePinStore({ [ICCID]: "4321" });
    const clock = fakeClock(2000);
    const kinds: WatchdogActionKind[] = [];

    const result = await runWatchdogTick({
      client: client(script),
      password: "s3cr3t",
      pinStore,
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
      now: clock.now,
      sleep: clock.sleep,
      onAction: (kind) => {
        kinds.push(kind);
      },
    });

    expect(result.event.kind).toBe("unlocked");
    expect(kinds).toEqual(["unlocking", "connecting"]);
  });

  it("fires reconnecting before reconnect()", async () => {
    const connected = buildModel({ connection: "Connected" });
    const disconnected = buildModel({ connection: "Disconnected" });
    const script = [
      connected,
      connected,
      disconnected,
      disconnected,
      connected,
    ];
    const clock = fakeClock(1000);
    const kinds: WatchdogActionKind[] = [];

    const result = await runWatchdogTick({
      client: client(script),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: {
        internetFailures: 1,
        lastReconnectAt: null,
        reconnectStreak: 0,
        lastRejoinAttemptAt: null,
        lastRoamingAttemptAt: null,
        stuckStreak: 0,
        dataToggledAt: null,
        lastRebootAt: null,
        lastBattery: null,
        lowBatteryNoticeLevel: null,
        batteryEmptyAt: null,
        noServiceSince: null,
        lastNoServiceRebootAt: null,
        noServiceRebootCount: 0,
        reboot: null,
      },
      probeInternet: async () => false,
      now: clock.now,
      sleep: clock.sleep,
      onAction: (kind) => {
        kinds.push(kind);
      },
    });

    expect(result.event.kind).toBe("reconnected");
    expect(kinds).toEqual(["reconnecting"]);
  });

  it("fires rejoining before a Wi-Fi rejoin attempt", async () => {
    const wifi = new FakeWifiRejoiner(true);
    const credsStore = new FakeWifiCredsStore({
      ssid: "FakeNet",
      passphrase: "x",
    });
    const kinds: WatchdogActionKind[] = [];

    await runWatchdogTick({
      client: clientBackAfterRejoin(),
      password: null,
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => false,
      wifi,
      credsStore,
      onAction: (kind) => {
        kinds.push(kind);
      },
    });

    expect(kinds).toEqual(["rejoining"]);
  });

  it("never fires onAction for a plain idle or ok tick", async () => {
    const connected = buildModel({ connection: "Connected" });
    const kinds: WatchdogActionKind[] = [];
    await runWatchdogTick({
      client: client([connected]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
      onAction: (kind) => {
        kinds.push(kind);
      },
    });
    expect(kinds).toHaveLength(0);
  });

  it("breadcrumbMessage covers every WatchdogActionKind with an in-progress line", () => {
    const kinds: WatchdogActionKind[] = [
      "unlocking",
      "connecting",
      "reconnecting",
      "rejoining",
      "toggling-data",
      "rebooting",
    ];
    for (const kind of kinds) {
      expect(breadcrumbMessage(kind)).toMatch(/^In progress:/);
    }
  });
});

describe("runWatchdogTick — hard budget", () => {
  it("the worst-case unlock path (SIM never settles) stays under the budget", async () => {
    const locked = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const pinStore = new FakePinStore({ [ICCID]: "4321" });
    const clock = fakeClock(2000);
    let elapsed = 0;
    const now = () => {
      elapsed = clock.now();
      return elapsed;
    };

    const result = await runWatchdogTick({
      client: client([locked]), // sticky — the SIM never becomes Ready
      password: "s3cr3t",
      pinStore,
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
      now,
      sleep: clock.sleep,
    });

    expect(result.event.kind).toBe("needs-pin");
    expect(elapsed).toBeLessThan(DEFAULT_WATCHDOG_BUDGET_MS);
  });

  it("the worst-case connect path (never reaches Connected) stays under the budget", async () => {
    const disconnected = buildModel({ connection: "Disconnected" });
    const clock = fakeClock(2000);
    let elapsed = 0;
    const now = () => {
      elapsed = clock.now();
      return elapsed;
    };

    const result = await runWatchdogTick({
      client: client([disconnected]), // sticky — never Connected
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
      now,
      sleep: clock.sleep,
    });

    expect(result.event.kind).toBe("connect-failed");
    expect(elapsed).toBeLessThan(DEFAULT_WATCHDOG_BUDGET_MS);
  });

  it("the worst-case reconnect path (never leaves Connected) stays under the budget", async () => {
    const connected = buildModel({ connection: "Connected" });
    const clock = fakeClock(2000);
    let elapsed = 0;
    const now = () => {
      elapsed = clock.now();
      return elapsed;
    };

    const result = await runWatchdogTick({
      client: client([connected]), // sticky — disconnect() never observably completes
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: {
        internetFailures: 1,
        lastReconnectAt: null,
        reconnectStreak: 0,
        lastRejoinAttemptAt: null,
        lastRoamingAttemptAt: null,
        stuckStreak: 0,
        dataToggledAt: null,
        lastRebootAt: null,
        lastBattery: null,
        lowBatteryNoticeLevel: null,
        batteryEmptyAt: null,
        noServiceSince: null,
        lastNoServiceRebootAt: null,
        noServiceRebootCount: 0,
        reboot: null,
      },
      probeInternet: async () => false,
      now,
      sleep: clock.sleep,
    });

    expect(result.event.kind).toBe("reconnect-failed");
    expect(elapsed).toBeLessThan(DEFAULT_WATCHDOG_BUDGET_MS);
  });

  it("scaledTimeouts keeps both possible long branches comfortably under the budget", () => {
    const t = scaledTimeouts(DEFAULT_WATCHDOG_BUDGET_MS);
    expect(
      (t.unlockMs ?? 0) + (t.checkMs ?? 0) + (t.connectMs ?? 0),
    ).toBeLessThan(DEFAULT_WATCHDOG_BUDGET_MS);
    expect((t.disconnectMs ?? 0) + (t.connectMs ?? 0)).toBeLessThan(
      DEFAULT_WATCHDOG_BUDGET_MS,
    );
  });

  it("scales every timeout down proportionally for a smaller budget", () => {
    const full = scaledTimeouts(DEFAULT_WATCHDOG_BUDGET_MS);
    const half = scaledTimeouts(DEFAULT_WATCHDOG_BUDGET_MS / 2);
    expect(half.unlockMs).toBe(Math.round((full.unlockMs ?? 0) / 2));
    expect(half.connectMs).toBe(Math.round((full.connectMs ?? 0) / 2));
  });
});

describe("formatSubtitle", () => {
  function event(kind: WatchdogEvent["kind"], message: string): WatchdogEvent {
    return { at: Date.UTC(2026, 0, 1, 14, 2), kind, message };
  }

  it("shows the message and time for a healthy state", () => {
    expect(formatSubtitle(event("ok", "OK · 4G+"))).toMatch(
      /^OK · 4G\+ · \d{2}:\d{2}$/,
    );
  });

  it("shows a fixed line for needs-pin regardless of message", () => {
    expect(formatSubtitle(event("needs-pin", "anything"))).toBe(
      "SIM PIN needed",
    );
  });

  it("shows the deferred message as-is", () => {
    expect(
      formatSubtitle(event("deferred", "Manual action in progress — skipped")),
    ).toBe("Manual action in progress — skipped");
  });

  it("summarises the reboot lifecycle events", () => {
    expect(
      formatSubtitle(event("rebooted", "Router stuck — restarted it")),
    ).toMatch(/^Restarted router · \d{2}:\d{2}$/);
    expect(formatSubtitle(event("rebooting", "x"))).toBe("Router restarting…");
    expect(
      formatSubtitle(event("recovered", "Back online after restart")),
    ).toMatch(/^Back online after restart · \d{2}:\d{2}$/);
  });

  it("summarises the data toggle events", () => {
    expect(
      formatSubtitle(event("data-toggled", "Mobile data switched off/on")),
    ).toMatch(/^Data reset · \d{2}:\d{2}$/);
    expect(formatSubtitle(event("data-toggle-failed", "x"))).toMatch(
      /^Failed · \d{2}:\d{2}$/,
    );
  });

  it("prefixes idle with the reason", () => {
    expect(formatSubtitle(event("idle", "Router not reachable"))).toBe(
      "Idle · Router not reachable",
    );
  });
});

describe("appendWatchdogEvent", () => {
  const empty = { events: [], counts: {}, since: null };
  const ev = (
    at: number,
    kind: "ok" | "probe-failed",
    message = "OK · 4G+",
  ) => ({
    at,
    kind,
    message,
  });

  it("collapses consecutive identical routine ticks into one entry", () => {
    let log = appendWatchdogEvent(empty, ev(1000, "ok"));
    log = appendWatchdogEvent(log, ev(2000, "ok"));
    log = appendWatchdogEvent(log, ev(3000, "ok"));
    expect(log.events).toEqual([
      { at: 3000, kind: "ok", message: "OK · 4G+", firstAt: 1000, count: 3 },
    ]);
    expect(log.counts).toEqual({ ok: 3 });
    expect(log.since).toBe(1000);
  });

  it("keeps noteworthy events as their own rows and breaks the run", () => {
    let log = appendWatchdogEvent(empty, ev(1000, "ok"));
    log = appendWatchdogEvent(log, ev(2000, "probe-failed", "x"));
    log = appendWatchdogEvent(log, ev(3000, "probe-failed", "x"));
    log = appendWatchdogEvent(log, ev(4000, "ok"));
    expect(log.events.map((e) => e.kind)).toEqual([
      "ok",
      "probe-failed",
      "probe-failed",
      "ok",
    ]);
    expect(log.counts).toEqual({ ok: 2, "probe-failed": 2 });
  });

  it("collapses consecutive deferred ticks like routine ones", () => {
    const deferred = (at: number) => ({
      at,
      kind: "deferred" as const,
      message: "Manual action in progress — skipped",
    });
    let log = appendWatchdogEvent(empty, deferred(1000));
    log = appendWatchdogEvent(log, deferred(2000));
    expect(log.events).toHaveLength(1);
    expect(log.events[0].count).toBe(2);
  });

  it("does not merge ticks whose message changed", () => {
    let log = appendWatchdogEvent(empty, ev(1000, "ok", "OK · 4G+"));
    log = appendWatchdogEvent(log, ev(2000, "ok", "OK · 4G"));
    expect(log.events).toHaveLength(2);
  });
});

// A router that accepts connect() but never connects (the 2026-10-04
// incident) and accepts the reboot POST — records every POST.
class StuckRouterHttp extends ScriptedNetgearHttp {
  async postForm(
    url: string,
    fields: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    this.postCalls.push({ url, fields });
    return {
      status: 200,
      body: "general.shutdown" in fields ? SUCCESS_BODY : REJECTED_BODY,
    };
  }
  get reboots(): number {
    return this.postCalls.filter(
      (c) => c.fields["general.shutdown"] === "restart",
    ).length;
  }
}

describe("runWatchdogTick — last-resort reboot", () => {
  const BASE = 10 * 60_000;

  function stuck(
    model: RouterModel = buildModel({ connection: "Disconnected" }),
  ) {
    const transport = new StuckRouterHttp([model]);
    return {
      transport,
      netgear: new NetgearClient({ host: "http://192.168.1.1", transport }),
    };
  }

  function tick(
    netgear: NetgearClient,
    state: WatchdogState,
    extra: Partial<Parameters<typeof runWatchdogTick>[0]> = {},
  ) {
    const clock = fakeClock(30_000);
    return runWatchdogTick({
      client: netgear,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state,
      probeInternet: async () => true,
      now: () => BASE + clock.now(),
      sleep: clock.sleep,
      ...extra,
    });
  }

  it("reboots on the second consecutive connect-failed tick, not before", async () => {
    const { transport, netgear } = stuck();
    const first = await tick(netgear, INITIAL_WATCHDOG_STATE);
    expect(first.event.kind).toBe("connect-failed");
    expect(first.state.stuckStreak).toBe(1);
    expect(transport.reboots).toBe(0);

    const second = await tick(netgear, first.state);
    expect(second.event.kind).toBe("rebooted");
    expect(second.event.message).toBe(
      "Router stuck — restarted it (could not connect)",
    );
    expect(transport.reboots).toBe(1);
    expect(second.state).toMatchObject({
      stuckStreak: 0,
      reconnectStreak: 0,
      internetFailures: 0,
      reboot: { source: "watchdog", iccid: ICCID },
    });
    expect(second.state.lastRebootAt).toBe(second.state.reboot?.at);
  });

  it("logs wwan.connection and inactivityCause on connect-failed and rebooted", async () => {
    const model = buildModel({ connection: "Disconnected" });
    const withCause: RouterModel = {
      ...model,
      wwan: { ...model.wwan, inactivityCause: 65539 },
    };
    const { netgear } = stuck(withCause);
    const failed = await tick(netgear, INITIAL_WATCHDOG_STATE);
    expect(failed.event.kind).toBe("connect-failed");
    expect(failed.event.detail).toContain(
      "wwan.connection=Disconnected, wwan.inactivityCause=65539",
    );

    const rebooted = await tick(netgear, {
      ...INITIAL_WATCHDOG_STATE,
      stuckStreak: 1,
    });
    expect(rebooted.event.kind).toBe("rebooted");
    expect(rebooted.event.detail).toContain(
      "wwan.connection=Disconnected, wwan.inactivityCause=65539",
    );
  });

  it("announces the reboot through the rebooting breadcrumb", async () => {
    const { netgear } = stuck();
    const actions: string[] = [];
    await tick(
      netgear,
      { ...INITIAL_WATCHDOG_STATE, stuckStreak: 1 },
      { onAction: (kind) => void actions.push(kind) },
    );
    expect(actions).toEqual(["connecting", "rebooting"]);
  });

  it("never reboots twice within 30 minutes", async () => {
    const { transport, netgear } = stuck();
    const recent: WatchdogState = {
      ...INITIAL_WATCHDOG_STATE,
      stuckStreak: 5,
      lastRebootAt: BASE - 10 * 60_000,
    };
    const blocked = await tick(netgear, recent);
    expect(blocked.event.kind).toBe("connect-failed");
    expect(transport.reboots).toBe(0);

    const cooled = await tick(netgear, {
      ...recent,
      lastRebootAt: BASE - REBOOT_COOLDOWN_MS - 60_000,
    });
    expect(cooled.event.kind).toBe("rebooted");
    expect(transport.reboots).toBe(1);
  });

  it("respects the 30-minute cooldown on the second connect-failed tick too", async () => {
    const { transport, netgear } = stuck();
    const recent: WatchdogState = {
      ...INITIAL_WATCHDOG_STATE,
      stuckStreak: 1,
      lastRebootAt: BASE - 10 * 60_000,
    };
    const blocked = await tick(netgear, recent);
    expect(blocked.event.kind).toBe("connect-failed");
    expect(blocked.state.stuckStreak).toBe(2);
    expect(transport.reboots).toBe(0);

    const cooled = await tick(netgear, {
      ...recent,
      lastRebootAt: BASE - REBOOT_COOLDOWN_MS - 60_000,
    });
    expect(cooled.event.kind).toBe("rebooted");
    expect(transport.reboots).toBe(1);
  });

  it("keeps the threshold of three for a reconnect-failed tick (router Connected)", async () => {
    // Connected but the reconnect itself fails: not the stuck-Disconnected
    // case, so it escalates to the toggle/threshold-3 ladder, not the 2-tick one.
    const transport = new DataRouterHttp({
      connection: "Connected",
      stuck: true,
    });
    const netgear = new NetgearClient({
      host: "http://192.168.1.1",
      transport,
    });
    const afterToggle: WatchdogState = {
      ...INITIAL_WATCHDOG_STATE,
      stuckStreak: 1,
      internetFailures: 1,
      dataToggledAt: BASE - 1,
    };
    const second = await tick(netgear, afterToggle, {
      probeInternet: async () => false,
    });
    expect(second.event.kind).toBe("reconnect-failed");
    expect(second.state.stuckStreak).toBe(2);
    expect(transport.reboots).toBe(0);

    const third = await tick(
      new NetgearClient({
        host: "http://192.168.1.1",
        transport: new DataRouterHttp({ connection: "Connected", stuck: true }),
      }),
      { ...second.state, lastReconnectAt: null, reconnectStreak: 0 },
      { probeInternet: async () => false },
    );
    expect(third.event.kind).toBe("rebooted");
    expect(third.event.message).toContain("reconnects failed");
  });

  it("never reboots a Locked SIM", async () => {
    const locked = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const { transport, netgear } = stuck(locked);
    const result = await tick(netgear, {
      ...INITIAL_WATCHDOG_STATE,
      stuckStreak: 5,
    });
    expect(result.event.kind).toBe("needs-pin");
    expect(transport.reboots).toBe(0);
  });

  it("counts a failed probe as stuck only after reconnects didn't help", async () => {
    const connected = buildModel({ connection: "Connected" });
    const noHelp = await tick(client([connected]), INITIAL_WATCHDOG_STATE, {
      probeInternet: async () => false,
      budgetMs: CROSS_TICK_BUDGET_MS,
    });
    expect(noHelp.event.kind).toBe("probe-failed");
    expect(noHelp.state.stuckStreak).toBe(0);

    const afterReconnects = await tick(
      client([connected]),
      {
        ...INITIAL_WATCHDOG_STATE,
        reconnectStreak: 2,
        stuckStreak: 1,
        dataToggledAt: BASE - 1,
      },
      { probeInternet: async () => false, budgetMs: CROSS_TICK_BUDGET_MS },
    );
    expect(afterReconnects.event.kind).toBe("probe-failed");
    expect(afterReconnects.state.stuckStreak).toBe(2);
  });

  it("reboots when no internet persists after reconnects", async () => {
    const transport = new StuckRouterHttp([
      buildModel({ connection: "Connected" }),
    ]);
    const result = await tick(
      new NetgearClient({ host: "http://192.168.1.1", transport }),
      {
        ...INITIAL_WATCHDOG_STATE,
        reconnectStreak: 3,
        stuckStreak: 2,
        lastReconnectAt: BASE, // reconnect backoff still running
      },
      { probeInternet: async () => false },
    );
    expect(result.event.kind).toBe("rebooted");
    expect(result.event.message).toContain("no internet after reconnects");
    expect(transport.reboots).toBe(1);
  });

  it("resets the streak on ok and on connected", async () => {
    const ok = await tick(client([buildModel({ connection: "Connected" })]), {
      ...INITIAL_WATCHDOG_STATE,
      stuckStreak: 2,
    });
    expect(ok.event.kind).toBe("ok");
    expect(ok.state.stuckStreak).toBe(0);

    const connected = await tick(
      client([
        buildModel({ connection: "Disconnected" }),
        buildModel({ connection: "Connected" }),
      ]),
      { ...INITIAL_WATCHDOG_STATE, stuckStreak: 2 },
    );
    expect(connected.event.kind).toBe("connected");
    expect(connected.state.stuckStreak).toBe(0);
  });

  it("reports a refused reboot as an error and starts the cooldown anyway", async () => {
    const transport = new ScriptedNetgearHttp(
      [buildModel({ connection: "Disconnected" })],
      [REJECTED_BODY],
    );
    const result = await tick(
      new NetgearClient({ host: "http://192.168.1.1", transport }),
      { ...INITIAL_WATCHDOG_STATE, stuckStreak: 2 },
    );
    expect(result.event.kind).toBe("error");
    expect(result.state.reboot).toBeNull();
    expect(result.state.lastRebootAt).not.toBeNull();
  });
});

describe("runWatchdogTick — data off/on soft reset", () => {
  const BASE = 10 * 60_000;

  function setup(opts: ConstructorParameters<typeof DataRouterHttp>[0]) {
    const transport = new DataRouterHttp({
      connection: "Disconnected",
      stuck: true,
      ...opts,
    });
    return {
      transport,
      netgear: new NetgearClient({ host: "http://192.168.1.1", transport }),
    };
  }

  function tick(
    netgear: NetgearClient,
    state: WatchdogState,
    extra: Partial<Parameters<typeof runWatchdogTick>[0]> = {},
  ) {
    const clock = fakeClock(30_000);
    return runWatchdogTick({
      client: netgear,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state,
      probeInternet: async () => true,
      now: () => BASE + clock.now(),
      sleep: clock.sleep,
      ...extra,
    });
  }

  // Connected, but the internet probe fails after the reconnects already
  // didn't help — the only scenario the toggle still runs in. A router stuck
  // Disconnected skips it (see the first test below).
  const NO_INTERNET: WatchdogState = {
    ...INITIAL_WATCHDOG_STATE,
    reconnectStreak: 2,
  };
  const noInternet = async () => false;

  it("never toggles a router stuck Disconnected — reboots on the second connect-failed tick", async () => {
    const { transport, netgear } = setup({});
    const first = await tick(netgear, INITIAL_WATCHDOG_STATE);
    expect(first.event.kind).toBe("connect-failed");
    expect(first.state.stuckStreak).toBe(1);
    expect(transport.autoconnectWrites).toEqual([]);
    expect(transport.reboots).toBe(0);

    const second = await tick(netgear, first.state);
    expect(second.event.kind).toBe("rebooted");
    expect(transport.reboots).toBe(1);
    expect(transport.autoconnectWrites).toEqual([]);
  });

  it("toggles data on the second stuck tick instead of the normal action, then recovers without a reboot", async () => {
    const { transport, netgear } = setup({ connection: "Connected" });
    let online = false;
    const probeInternet = async () => online;
    const first = await tick(netgear, NO_INTERNET, {
      probeInternet,
      budgetMs: CROSS_TICK_BUDGET_MS,
    });
    expect(first.event.kind).toBe("probe-failed");
    expect(first.state.stuckStreak).toBe(1);
    expect(transport.autoconnectWrites).toEqual([]);

    const toggled = await tick(netgear, first.state, { probeInternet });
    expect(toggled.event.kind).toBe("data-toggled");
    expect(toggled.event.message).toBe(
      "Mobile data switched off/on to reset the connection",
    );
    expect(transport.autoconnectWrites).toEqual(["Never", "Always"]);
    expect(toggled.state.stuckStreak).toBe(2);
    expect(toggled.state.dataToggledAt).not.toBeNull();
    expect(transport.reboots).toBe(0);

    online = true;
    const ok = await tick(netgear, toggled.state, { probeInternet });
    expect(ok.event.kind).toBe("ok");
    expect(ok.state).toMatchObject({ stuckStreak: 0, dataToggledAt: null });
    expect(transport.reboots).toBe(0);
  });

  it("toggles once per stuck episode, then the third stuck tick reboots", async () => {
    const { transport, netgear } = setup({
      connection: "Connected",
      toggleFixes: false,
    });
    const state: WatchdogState = { ...NO_INTERNET, stuckStreak: 1 };

    const toggled = await tick(netgear, state, { probeInternet: noInternet });
    expect(toggled.event.kind).toBe("data-toggle-failed");
    expect(toggled.event.message).toContain("Timed out waiting to connect");
    expect(toggled.state.stuckStreak).toBe(2);
    expect(toggled.state.dataToggledAt).not.toBeNull();
    expect(transport.reboots).toBe(0);

    // The failed toggle left the router Disconnected: the stuck-Disconnected
    // rule reboots (streak 3 also clears its threshold of 2).
    const third = await tick(netgear, toggled.state, {
      probeInternet: noInternet,
    });
    expect(third.event.kind).toBe("rebooted");
    expect(transport.reboots).toBe(1);
    expect(transport.autoconnectWrites).toEqual(["Never", "Always"]);
    expect(third.state).toMatchObject({ stuckStreak: 0, dataToggledAt: null });
  });

  it("does not toggle again within the same episode", async () => {
    const { transport, netgear } = setup({
      connection: "Connected",
      toggleFixes: false,
    });
    const result = await tick(
      netgear,
      { ...NO_INTERNET, stuckStreak: 1, dataToggledAt: BASE - 60_000 },
      { probeInternet: noInternet, budgetMs: CROSS_TICK_BUDGET_MS },
    );
    expect(result.event.kind).toBe("probe-failed");
    expect(transport.autoconnectWrites).toEqual([]);
  });

  it("does not toggle a router that is healthy again", async () => {
    const transport = new DataRouterHttp({ connection: "Connected" });
    const result = await tick(
      new NetgearClient({ host: "http://192.168.1.1", transport }),
      { ...INITIAL_WATCHDOG_STATE, stuckStreak: 1 },
    );
    expect(result.event.kind).toBe("ok");
    expect(result.state.stuckStreak).toBe(0);
    expect(transport.autoconnectWrites).toEqual([]);
  });

  it("toggles instead of reconnecting when the internet stays down", async () => {
    const transport = new DataRouterHttp({ connection: "Connected" });
    const result = await tick(
      new NetgearClient({ host: "http://192.168.1.1", transport }),
      { ...INITIAL_WATCHDOG_STATE, stuckStreak: 1, internetFailures: 1 },
      { probeInternet: async () => false },
    );
    expect(result.event.kind).toBe("data-toggled");
    expect(transport.autoconnectWrites).toEqual(["Never", "Always"]);
  });

  it("toggles on a failed probe that already counts as stuck", async () => {
    const transport = new DataRouterHttp({ connection: "Connected" });
    const result = await tick(
      new NetgearClient({ host: "http://192.168.1.1", transport }),
      { ...INITIAL_WATCHDOG_STATE, stuckStreak: 1, reconnectStreak: 2 },
      { probeInternet: async () => false },
    );
    expect(result.event.kind).toBe("data-toggled");
    expect(result.state.stuckStreak).toBe(2);
  });

  it("never leaves autoconnect at Never, whatever the outcome", async () => {
    for (const opts of [
      {},
      { toggleFixes: false },
      { dropOnNever: false },
    ] as const) {
      const { transport, netgear } = setup({
        connection: "Connected",
        ...opts,
      });
      await tick(
        netgear,
        { ...NO_INTERNET, stuckStreak: 1 },
        { probeInternet: noInternet },
      );
      expect(transport.autoconnect).toBe("Always");
      expect(transport.autoconnectWrites.at(-1)).toBe("Always");
    }
  });

  it("never toggles with a SIM that is not Ready", async () => {
    const blocked = buildModel({
      sim: {
        status: "Blocked",
        pin: { mode: "Enabled", retry: 0 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const transport = new ScriptedNetgearHttp([blocked]);
    const result = await tick(
      new NetgearClient({ host: "http://192.168.1.1", transport }),
      { ...INITIAL_WATCHDOG_STATE, stuckStreak: 1 },
    );
    expect(result.event.kind).toBe("sim-problem");
    expect(transport.postCalls).toHaveLength(0);
  });

  it("announces the toggle through the toggling-data breadcrumb", async () => {
    const { netgear } = setup({ connection: "Connected" });
    const actions: string[] = [];
    await tick(
      netgear,
      { ...NO_INTERNET, stuckStreak: 1 },
      {
        probeInternet: noInternet,
        onAction: (kind) => void actions.push(kind),
      },
    );
    expect(actions).toEqual(["toggling-data"]);
  });

  it("logs wwan.connection and inactivityCause on a failed toggle", async () => {
    const { netgear } = setup({ connection: "Connected", toggleFixes: false });
    const result = await tick(
      netgear,
      { ...NO_INTERNET, stuckStreak: 1 },
      { probeInternet: noInternet },
    );
    expect(result.event.kind).toBe("data-toggle-failed");
    expect(result.event.detail).toContain(
      "wwan.connection=Disconnected, wwan.inactivityCause=n/a",
    );
  });

  it("the worst-case toggle (data never drops) stays under the budget", async () => {
    const { netgear } = setup({ dropOnNever: false, connection: "Connected" });
    const clock = fakeClock(2000);
    let elapsed = 0;
    const result = await runWatchdogTick({
      client: netgear,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: {
        ...INITIAL_WATCHDOG_STATE,
        stuckStreak: 1,
        internetFailures: 1,
      },
      probeInternet: async () => false,
      now: () => (elapsed = clock.now()),
      sleep: clock.sleep,
    });
    expect(result.event.kind).toBe("data-toggle-failed");
    expect(elapsed).toBeLessThan(DEFAULT_WATCHDOG_BUDGET_MS);
  });
});

describe("runWatchdogTick — recovery after a reboot", () => {
  const AT = 100_000;
  const marker: RebootMarker = { at: AT, source: "watchdog", iccid: ICCID };
  const rebooting: WatchdogState = {
    ...INITIAL_WATCHDOG_STATE,
    reboot: marker,
    lastRebootAt: AT,
  };
  const CREDS = { ssid: "FakeNet", passphrase: "x" };

  it("rejoins Wi-Fi immediately while unreachable and the Mac is offline", async () => {
    const wifi = new FakeWifiRejoiner(true);
    const result = await runWatchdogTick({
      client: clientBackAfterRejoin(),
      password: null,
      pinStore: new FakePinStore(),
      state: { ...rebooting, lastRejoinAttemptAt: 0 }, // 5-min backoff n/a
      probeInternet: async () => false,
      wifi,
      credsStore: new FakeWifiCredsStore(CREDS),
      now: () => AT + 10_000,
    });
    expect(result.event.kind).toBe("rejoined");
    expect(wifi.rejoinCalls).toEqual([CREDS]);
    expect(result.state.lastRejoinAttemptAt).toBe(AT + 10_000);
    expect(result.state.reboot).toEqual(marker);
  });

  // Live 2026-10-06: after a manual restart the user switched to a phone
  // hotspot, and the post-restart rejoin kept pulling the Mac back onto the
  // (still dead) router Wi-Fi.
  it("never switches Wi-Fi after a restart while the Mac is online elsewhere", async () => {
    const wifi = new FakeWifiRejoiner(true);
    const result = await runWatchdogTick({
      client: clientBackAfterRejoin(),
      password: null,
      pinStore: new FakePinStore(),
      state: { ...rebooting, lastRejoinAttemptAt: 0 },
      probeInternet: async () => true,
      wifi,
      credsStore: new FakeWifiCredsStore(CREDS),
      now: () => AT + 10_000,
    });
    expect(result.event.kind).toBe("rebooting");
    expect(result.event.message).toMatch(/online elsewhere/);
    expect(wifi.rejoinCalls).toHaveLength(0);
    expect(result.state.reboot).toEqual(marker);
  });

  it("rejoins at most once per 30 seconds, otherwise waits quietly", async () => {
    const wifi = new FakeWifiRejoiner(true);
    const run = (now: number, last: number) =>
      runWatchdogTick({
        client: clientBackAfterRejoin(),
        password: null,
        pinStore: new FakePinStore(),
        state: { ...rebooting, lastRejoinAttemptAt: last },
        probeInternet: async () => false,
        wifi,
        credsStore: new FakeWifiCredsStore(CREDS),
        now: () => now,
      });
    const early = await run(AT + 20_000, AT + 10_000);
    expect(early.event.kind).toBe("rebooting");
    expect(wifi.rejoinCalls).toHaveLength(0);

    const later = await run(AT + 40_000, AT + 10_000);
    expect(later.event.kind).toBe("rejoined");
    expect(wifi.rejoinCalls).toHaveLength(1);
  });

  it("waits without Wi-Fi credentials", async () => {
    const result = await runWatchdogTick({
      client: client([new Error("curl exited 7")]),
      password: null,
      pinStore: new FakePinStore(),
      state: rebooting,
      probeInternet: async () => false,
      wifi: new FakeWifiRejoiner(true),
      credsStore: new FakeWifiCredsStore(null),
      now: () => AT + 10_000,
    });
    expect(result.event.kind).toBe("rebooting");
    expect(result.state.reboot).toEqual(marker);
  });

  it("goes back to the normal idle rule once the recovery window has passed", async () => {
    const wifi = new FakeWifiRejoiner(true);
    const result = await runWatchdogTick({
      client: client([new Error("curl exited 7")]),
      password: null,
      pinStore: new FakePinStore(),
      state: rebooting,
      probeInternet: async () => true, // online → the normal rule never rejoins
      wifi,
      credsStore: new FakeWifiCredsStore(CREDS),
      now: () => AT + REBOOT_RECOVERY_WINDOW_MS + 1,
    });
    expect(result.event.kind).toBe("idle");
    expect(wifi.rejoinCalls).toHaveLength(0);
    expect(result.state.reboot).toEqual(marker); // kept for the view's warning
  });

  it("drops a marker after 30 minutes", async () => {
    const result = await runWatchdogTick({
      client: client([new Error("curl exited 7")]),
      password: null,
      pinStore: new FakePinStore(),
      state: rebooting,
      probeInternet: async () => true,
      now: () => AT + 31 * 60_000,
    });
    expect(result.state.reboot).toBeNull();
  });

  it("unlocks with the marker's ICCID when the Locked SIM hides its own", async () => {
    const hidden = (status: string, connection: string) =>
      buildModel({
        sim: {
          status,
          pin: { mode: "Enabled", retry: 3 },
          puk: { retry: 10 },
          ...(status === "Ready" ? { iccid: ICCID } : {}),
        },
        connection,
      });
    const locked = hidden("Locked", "Disconnected");
    const ready = hidden("Ready", "Connected");
    const script = [locked, locked, locked, ready, ready];
    const clock = fakeClock(2000);
    const result = await runWatchdogTick({
      client: client(script),
      password: "s3cr3t",
      pinStore: new FakePinStore({ [ICCID]: "4321" }),
      state: rebooting,
      probeInternet: async () => true,
      now: () => AT + clock.now(),
      sleep: clock.sleep,
    });
    expect(result.event.kind).toBe("unlocked");
  });

  it("recovers: Connected + online clears the marker and the streak", async () => {
    const result = await runWatchdogTick({
      client: client([buildModel({ connection: "Connected" })]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: { ...rebooting, stuckStreak: 2 },
      probeInternet: async () => true,
      now: () => AT + 90_000,
    });
    expect(result.event).toMatchObject({
      kind: "recovered",
      message: "Back online after restart",
    });
    expect(result.state.reboot).toBeNull();
    expect(result.state.stuckStreak).toBe(0);
    expect(result.state.lastRebootAt).toBe(AT); // cooldown anchor stays
  });

  it("keeps the marker while the router still shows its pre-reboot uptime", async () => {
    const stale: RouterModel = {
      ...buildModel({ connection: "Connected" }),
      general: { upTime: 86_400 },
    };
    const result = await runWatchdogTick({
      client: client([stale]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: rebooting,
      probeInternet: async () => true,
      now: () => AT + 5_000,
    });
    expect(result.event.kind).toBe("ok");
    expect(result.state.reboot).toEqual(marker);
  });

  it("keeps the marker while Connected but the internet check still fails", async () => {
    const result = await runWatchdogTick({
      client: client([buildModel({ connection: "Connected" })]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: rebooting,
      probeInternet: async () => false,
      now: () => AT + 90_000,
      budgetMs: CROSS_TICK_BUDGET_MS,
    });
    expect(result.event.kind).toBe("probe-failed");
    expect(result.state.reboot).toEqual(marker);
  });

  it("does not reboot again while recovering from a reboot", async () => {
    const transport = new StuckRouterHttp([
      buildModel({ connection: "Disconnected" }),
    ]);
    const clock = fakeClock(30_000);
    const result = await runWatchdogTick({
      client: new NetgearClient({ host: "http://192.168.1.1", transport }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: { ...rebooting, stuckStreak: 5, lastRebootAt: null },
      probeInternet: async () => true,
      now: () => AT + clock.now(),
      sleep: clock.sleep,
    });
    expect(result.event.kind).toBe("connect-failed");
    expect(transport.reboots).toBe(0);
  });
});

describe("runWatchdogTick — in-tick internet confirm", () => {
  const connected = buildModel({ connection: "Connected" });
  const disconnected = buildModel({ connection: "Disconnected" });
  // watchdog getStatus, then reconnect(): state read, disconnect, poll
  // Disconnected, connect, poll Connected.
  const reconnectScript = [
    connected,
    connected,
    connected,
    disconnected,
    disconnected,
    connected,
  ];

  function probes(...results: boolean[]) {
    let calls = 0;
    return {
      probeInternet: async () => results[Math.min(calls++, results.length - 1)],
      calls: () => calls,
    };
  }

  function run(
    script: ConstructorParameters<typeof ScriptedNetgearHttp>[0],
    probe: ReturnType<typeof probes>,
    extra: Partial<Parameters<typeof runWatchdogTick>[0]> = {},
  ) {
    const clock = fakeClock(1000);
    const sleeps: number[] = [];
    const promise = runWatchdogTick({
      client: client(script),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: probe.probeInternet,
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...extra,
    });
    return { promise, sleeps };
  }

  it("a second failed probe 10s later reconnects in the same tick", async () => {
    const probe = probes(false, false);
    const { promise, sleeps } = run(reconnectScript, probe);
    const result = await promise;
    expect(sleeps[0]).toBe(CONFIRM_DELAY_MS);
    expect(probe.calls()).toBe(2);
    expect(result.event.kind).toBe("reconnected");
    expect(result.state).toMatchObject({
      internetFailures: 0,
      reconnectStreak: 1,
    });
  });

  it("a transient blip (re-probe succeeds) is a plain ok", async () => {
    const probe = probes(false, true);
    const { promise } = run([connected], probe);
    const result = await promise;
    expect(probe.calls()).toBe(2);
    expect(result.event.kind).toBe("ok");
    expect(result.event.detail).toBeUndefined();
    expect(result.state).toMatchObject({
      internetFailures: 0,
      reconnectStreak: 0,
    });
  });

  it("falls back to cross-tick counting when the budget is too short for the confirm", async () => {
    const probe = probes(false);
    const { promise, sleeps } = run([connected], probe, {
      budgetMs: CROSS_TICK_BUDGET_MS,
    });
    const result = await promise;
    expect(sleeps).toEqual([]);
    expect(probe.calls()).toBe(1);
    expect(result.event.kind).toBe("probe-failed");
    expect(result.state.internetFailures).toBe(1);
  });

  it("does not confirm while a reconnect backoff is running", async () => {
    const probe = probes(false);
    const { promise, sleeps } = run([connected], probe, {
      state: {
        ...INITIAL_WATCHDOG_STATE,
        reconnectStreak: 1,
        lastReconnectAt: 0,
      },
      now: () => 30_000,
    });
    const result = await promise;
    expect(sleeps).toEqual([]);
    expect(probe.calls()).toBe(1);
    expect(result.event.kind).toBe("probe-failed");
  });

  // Tinycast kills a run at 60s. The fake clock does not model sleep or the
  // probe's curl timeout, so both are added to the elapsed time here.
  async function elapsedWorstCase(state: WatchdogState, router: RouterModel[]) {
    const clock = fakeClock(1000);
    let extra = 0;
    const now = () => clock.now() + extra;
    const result = await runWatchdogTick({
      client: client(router),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state,
      probeInternet: async () => {
        extra += PROBE_TIMEOUT_MS; // every probe runs into its timeout
        return false;
      },
      now,
      sleep: async (ms) => {
        extra += ms;
      },
    });
    return { result, elapsed: now() };
  }

  it("the confirm plus a never-succeeding reconnect stays under Tinycast's 60s kill", async () => {
    const { result, elapsed } = await elapsedWorstCase(
      INITIAL_WATCHDOG_STATE,
      [connected], // sticky — disconnect never observably completes
    );
    expect(result.event.kind).toBe("reconnect-failed");
    expect(elapsed).toBeGreaterThan(CONFIRM_COST_MS);
    expect(elapsed).toBeLessThan(60_000);
  });

  it("the confirm plus a failing data toggle stays under Tinycast's 60s kill", async () => {
    const clock = fakeClock(1000);
    let extra = 0;
    const now = () => clock.now() + extra;
    const result = await runWatchdogTick({
      client: new NetgearClient({
        host: "http://192.168.1.1",
        transport: new DataRouterHttp({
          connection: "Connected",
          stuck: true,
          toggleFixes: false,
        }),
      }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: { ...INITIAL_WATCHDOG_STATE, stuckStreak: 1 },
      probeInternet: async () => {
        extra += PROBE_TIMEOUT_MS;
        return false;
      },
      now,
      sleep: async (ms) => {
        extra += ms;
      },
    });
    expect(result.event.kind).toBe("data-toggle-failed");
    expect(now()).toBeLessThan(60_000);
  });
});

describe("incident context in the log detail", () => {
  it("formats band, radio quality, operator, RAT and LTE signal from the status", () => {
    expect(incidentContext(BASE_STATUS)).toBe(
      "band=LTE B7 radio=50% operator=Fakecom rat=4G+ rsrp=-98 rsrq=-12 sinr=4",
    );
  });

  it("falls back to n/a for unreadable text fields", () => {
    expect(
      incidentContext({
        ...BASE_STATUS,
        band: "",
        operator: "",
        rsrp: null,
        rsrq: null,
        sinr: null,
      }),
    ).toBe(
      "band=n/a radio=50% operator=n/a rat=4G+ rsrp=n/a rsrq=n/a sinr=n/a",
    );
  });

  it("keeps a legitimate 0 reading instead of calling it n/a", () => {
    expect(incidentContext({ ...BASE_STATUS, sinr: 0 })).toContain("sinr=0");
  });

  const CONTEXT =
    "band=LTE B7 radio=50% operator=Fakecom rat=4G+ rsrp=-98 rsrq=-12 sinr=4";

  it("is appended to a probe-failed and a reconnected event", async () => {
    const connected = buildModel({ connection: "Connected" });
    const failed = await runWatchdogTick({
      client: client([connected]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => false,
      budgetMs: CROSS_TICK_BUDGET_MS,
    });
    expect(failed.event.kind).toBe("probe-failed");
    expect(failed.event.detail).toBe(CONTEXT);

    const disconnected = buildModel({ connection: "Disconnected" });
    const reconnected = await runWatchdogTick({
      client: client([
        connected,
        connected,
        connected,
        disconnected,
        disconnected,
        connected,
      ]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: failed.state,
      probeInternet: async () => false,
      now: fakeClock(1000).now,
      sleep: async () => {},
    });
    expect(reconnected.event.kind).toBe("reconnected");
    expect(reconnected.event.detail).toBe(CONTEXT);
  });

  it("is appended to a connect-failed event ahead of the wwan diagnostics", async () => {
    const clock = fakeClock(30_000);
    const result = await runWatchdogTick({
      client: client([buildModel({ connection: "Disconnected" })]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.event.kind).toBe("connect-failed");
    expect(result.event.detail).toContain(CONTEXT);
    expect(result.event.detail).toContain("wwan.connection=");
    expect(result.event.detail?.indexOf(CONTEXT)).toBeLessThan(
      result.event.detail?.indexOf("wwan.connection=") ?? -1,
    );
  });

  it("is not added to routine events", async () => {
    const result = await runWatchdogTick({
      client: client([buildModel({ connection: "Connected" })]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => true,
    });
    expect(result.event.kind).toBe("ok");
    expect(result.event.detail).toBeUndefined();
  });
});

// Battery awareness — 2026-10-06: the router's battery died overnight and the
// watchdog logged eight "successful" Wi-Fi rejoins while it was off.
describe("runWatchdogTick — battery awareness", () => {
  const T0 = Date.UTC(2026, 9, 6, 0, 45);
  const CREDS = { ssid: "FakeNet", passphrase: "x" };
  const noSleep = async () => {};

  function batteryModel(level: number, charging: boolean): RouterModel {
    const model = buildModel({});
    model.power = { ...model.power, battChargeLevel: level, charging };
    return model;
  }

  function tick(opts: {
    level?: number;
    charging?: boolean;
    state?: Partial<WatchdogState>;
    now?: number;
    probe?: boolean;
    budgetMs?: number;
  }) {
    return runWatchdogTick({
      client: client([batteryModel(opts.level ?? 80, opts.charging ?? false)]),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: { ...INITIAL_WATCHDOG_STATE, ...opts.state },
      probeInternet: async () => opts.probe ?? true,
      now: () => opts.now ?? T0,
      sleep: noSleep,
      budgetMs: opts.budgetMs,
    });
  }

  describe("low battery notice", () => {
    it("announces once when the level crosses 20% without charging", async () => {
      const result = await tick({ level: 18 });
      expect(result.event.kind).toBe("battery-low");
      expect(result.event.message).toBe("Router battery 18% — plug it in");
      expect(result.state.lowBatteryNoticeLevel).toBe(20);
      expect(result.state.lastBattery).toEqual({
        level: 18,
        charging: false,
        at: T0,
      });
    });

    it("stays quiet on the following ticks of the same crossing", async () => {
      const result = await tick({
        level: 17,
        state: { lowBatteryNoticeLevel: 20 },
      });
      expect(result.event.kind).toBe("ok");
      expect(result.event.batteryLow).toBe(17);
      expect(result.state.lowBatteryNoticeLevel).toBe(20);
    });

    it("announces again at 10%, then not again", async () => {
      const at10 = await tick({
        level: 9,
        state: { lowBatteryNoticeLevel: 20 },
      });
      expect(at10.event.kind).toBe("battery-low");
      expect(at10.event.message).toBe("Router battery 9% — plug it in");
      expect(at10.state.lowBatteryNoticeLevel).toBe(10);
      const after = await tick({
        level: 8,
        state: { lowBatteryNoticeLevel: 10 },
      });
      expect(after.event.kind).toBe("ok");
    });

    it("announces a battery first seen below 10% once, as the 10% step", async () => {
      const result = await tick({ level: 6 });
      expect(result.event.kind).toBe("battery-low");
      expect(result.state.lowBatteryNoticeLevel).toBe(10);
    });

    it("never announces while charging, and re-arms when charging starts", async () => {
      const result = await tick({
        level: 15,
        charging: true,
        state: { lowBatteryNoticeLevel: 20 },
      });
      expect(result.event.kind).toBe("ok");
      expect(result.event.batteryLow).toBeUndefined();
      expect(result.state.lowBatteryNoticeLevel).toBeNull();
    });

    it("re-arms above 25% but not between 20% and 25%", async () => {
      const between = await tick({
        level: 23,
        state: { lowBatteryNoticeLevel: 20 },
      });
      expect(between.state.lowBatteryNoticeLevel).toBe(20);
      const above = await tick({
        level: 26,
        state: { lowBatteryNoticeLevel: 10 },
      });
      expect(above.state.lowBatteryNoticeLevel).toBeNull();
      const again = await tick({ level: 19, state: above.state });
      expect(again.event.kind).toBe("battery-low");
    });

    it("does not announce above 20%", async () => {
      const result = await tick({ level: 21 });
      expect(result.event.kind).toBe("ok");
      expect(result.state.lowBatteryNoticeLevel).toBeNull();
    });

    it("only replaces a plain ok — another event keeps the notice for later", async () => {
      const result = await tick({
        level: 18,
        probe: false,
        budgetMs: CROSS_TICK_BUDGET_MS,
      });
      expect(result.event.kind).toBe("probe-failed");
      expect(result.event.batteryLow).toBe(18);
      expect(result.state.lowBatteryNoticeLevel).toBeNull();
    });

    it("reads the battery from a Guest status too", async () => {
      const model = guestModel();
      model.power = { ...model.power, battChargeLevel: 12, charging: false };
      const result = await runWatchdogTick({
        client: client([model]),
        password: null,
        pinStore: new FakePinStore(),
        state: INITIAL_WATCHDOG_STATE,
        probeInternet: async () => true,
        now: () => T0,
      });
      expect(result.event.kind).toBe("no-password");
      expect(result.state.lastBattery).toEqual({
        level: 12,
        charging: false,
        at: T0,
      });
    });

    it("nextLowBatteryNotice walks the steps", () => {
      const step = (noticed: number | null, level: number, charging = false) =>
        nextLowBatteryNotice(noticed, { level, charging });
      expect(step(null, 30)).toEqual({ level: null, announce: false });
      expect(step(null, 20)).toEqual({ level: 20, announce: true });
      expect(step(20, 15)).toEqual({ level: 20, announce: false });
      expect(step(20, 10)).toEqual({ level: 10, announce: true });
      expect(step(10, 5)).toEqual({ level: 10, announce: false });
      expect(step(10, 25)).toEqual({ level: 10, announce: false });
      expect(step(10, 26)).toEqual({ level: null, announce: false });
      expect(step(10, 5, true)).toEqual({ level: null, announce: false });
    });
  });

  describe("battery empty", () => {
    const EMPTY: Partial<WatchdogState> = {
      lastBattery: { level: 4, charging: false, at: T0 },
    };
    const offline = (opts: {
      state?: Partial<WatchdogState>;
      now: number;
      wifi?: FakeWifiRejoiner;
      script?: ConstructorParameters<typeof ScriptedNetgearHttp>[0];
    }) =>
      runWatchdogTick({
        client: client(opts.script ?? [new Error("curl exited 7")]),
        password: null,
        pinStore: new FakePinStore(),
        state: { ...INITIAL_WATCHDOG_STATE, ...EMPTY, ...opts.state },
        probeInternet: async () => false,
        wifi: opts.wifi,
        credsStore: opts.wifi ? new FakeWifiCredsStore(CREDS) : undefined,
        now: () => opts.now,
        sleep: noSleep,
      });

    it("reports an unreachable router with a near-empty battery instead of idling", async () => {
      const result = await offline({ now: T0 + 3 * 3_600_000 });
      expect(result.event.kind).toBe("battery-empty");
      expect(result.event.message).toMatch(
        /^Router off — battery was 4% at \d{2}:\d{2}\. Plug it in\.$/,
      );
      expect(result.state.batteryEmptyAt).toBe(T0 + 3 * 3_600_000);
    });

    it("keeps the original time of the empty report across ticks", async () => {
      const first = await offline({ now: T0 + 60_000 });
      const second = await offline({
        now: T0 + 120_000,
        state: first.state,
      });
      expect(second.event.message).toBe(first.event.message);
      expect(second.state.batteryEmptyAt).toBe(T0 + 60_000);
    });

    it("is not triggered while charging, above 10%, or by a stale reading", async () => {
      const charging = await offline({
        now: T0 + 60_000,
        state: { lastBattery: { level: 4, charging: true, at: T0 } },
      });
      expect(charging.event.kind).toBe("idle");
      const above = await offline({
        now: T0 + 60_000,
        state: { lastBattery: { level: 11, charging: false, at: T0 } },
      });
      expect(above.event.kind).toBe("idle");
      const stale = await offline({ now: T0 + 12 * 3_600_000 + 1 });
      expect(stale.event.kind).toBe("idle");
    });

    it("skips the Wi-Fi rejoin while the retry backoff has not elapsed", async () => {
      const wifi = new FakeWifiRejoiner(true);
      const result = await offline({
        now: T0 + 10 * 60_000,
        wifi,
        state: { lastRejoinAttemptAt: T0 },
      });
      expect(result.event.kind).toBe("battery-empty");
      expect(wifi.rejoinCalls).toHaveLength(0);
    });

    it("tries the Wi-Fi at most once per 30 minutes in case it was plugged in", async () => {
      const wifi = new FakeWifiRejoiner(true);
      const result = await offline({
        now: T0 + 31 * 60_000,
        wifi,
        state: { lastRejoinAttemptAt: T0 },
      });
      expect(wifi.rejoinCalls).toHaveLength(1);
      // Joined, but the router is still not there: still empty, backoff reset.
      expect(result.event.kind).toBe("battery-empty");
      expect(result.state.lastRejoinAttemptAt).toBe(T0 + 31 * 60_000);
    });

    it("reports rejoined when that retry finds the router back", async () => {
      const wifi = new FakeWifiRejoiner(true);
      const result = await offline({
        now: T0 + 31 * 60_000,
        wifi,
        state: { lastRejoinAttemptAt: T0 },
        script: [new Error("curl exited 7"), buildModel({})],
      });
      expect(result.event.kind).toBe("rejoined");
    });

    it("collapses consecutive battery-empty ticks like idle", () => {
      const event = (at: number): WatchdogEvent => ({
        at,
        kind: "battery-empty",
        message: "Router off — battery was 4% at 00:45. Plug it in.",
      });
      const log = [1, 2, 3].reduce(
        (acc, n) => appendWatchdogEvent(acc, event(n * 60_000)),
        { events: [], counts: {}, since: null } as Parameters<
          typeof appendWatchdogEvent
        >[0],
      );
      expect(log.events).toHaveLength(1);
      expect(log.events[0]).toMatchObject({
        count: 3,
        firstAt: 60_000,
        at: 180_000,
      });
    });
  });

  describe("power restored", () => {
    const WAS_EMPTY: Partial<WatchdogState> = {
      batteryEmptyAt: T0,
      lastBattery: { level: 4, charging: false, at: T0 },
    };

    it("is announced once when the router is reachable again", async () => {
      const result = await tick({
        level: 5,
        charging: true,
        state: WAS_EMPTY,
        now: T0 + 8 * 3_600_000,
      });
      expect(result.event.kind).toBe("power-restored");
      expect(result.event.message).toBe(
        "Router back on power (battery 5%, charging)",
      );
      expect(result.state.batteryEmptyAt).toBeNull();
      expect(result.state.lastBattery).toMatchObject({
        level: 5,
        charging: true,
      });

      const next = await tick({
        level: 6,
        charging: true,
        state: result.state,
        now: T0 + 8 * 3_600_000 + 60_000,
      });
      expect(next.event.kind).toBe("ok");
    });

    it("waits for an informational tick — a failed connect keeps its own event", async () => {
      const disconnected = {
        ...batteryModel(5, true),
        wwan: { ...buildModel({}).wwan, connection: "Disconnected" },
      };
      class RejectConnect extends ScriptedNetgearHttp {
        async postForm(): Promise<{ status: number; body: string }> {
          return { status: 200, body: '{ "success": false }' };
        }
      }
      const clock = fakeClock(30_000);
      const result = await runWatchdogTick({
        client: new NetgearClient({
          host: "http://192.168.1.1",
          transport: new RejectConnect([disconnected]),
        }),
        password: "s3cr3t",
        pinStore: new FakePinStore(),
        state: { ...INITIAL_WATCHDOG_STATE, ...WAS_EMPTY },
        probeInternet: async () => true,
        now: clock.now,
        sleep: clock.sleep,
      });
      expect(result.event.kind).toBe("connect-failed");
      expect(result.state.batteryEmptyAt).toBe(T0);
    });

    it("keeps what the replaced event said in the detail", async () => {
      const model = batteryModel(5, true);
      model.sim = { ...model.sim, status: "Locked" };
      const result = await runWatchdogTick({
        client: client([model]),
        password: "s3cr3t",
        pinStore: new FakePinStore(),
        state: { ...INITIAL_WATCHDOG_STATE, ...WAS_EMPTY },
        probeInternet: async () => true,
        now: () => T0 + 60_000,
        sleep: noSleep,
      });
      expect(result.event.kind).toBe("power-restored");
      expect(result.event.detail).toMatch(/^needs-pin: SIM locked/);
    });
  });

  describe("rejoin only counts if the router answers", () => {
    it("reports rejoin-failed when the join succeeded but the router never answers", async () => {
      const wifi = new FakeWifiRejoiner(true);
      const result = await runWatchdogTick({
        client: client([new Error("curl exited 7")]),
        password: null,
        pinStore: new FakePinStore(),
        state: INITIAL_WATCHDOG_STATE,
        probeInternet: async () => false,
        wifi,
        credsStore: new FakeWifiCredsStore(CREDS),
        now: fakeClock(1_000).now,
        sleep: noSleep,
      });
      expect(wifi.rejoinCalls).toHaveLength(1);
      expect(result.event).toMatchObject({
        kind: "rejoin-failed",
        message: "Router not found on Wi-Fi — off or out of battery?",
      });
      expect(result.state.lastRejoinAttemptAt).not.toBeNull();
    });

    it("polls the router for about 10 seconds before giving up", async () => {
      const sleeps: number[] = [];
      await runWatchdogTick({
        client: client([new Error("curl exited 7")]),
        password: null,
        pinStore: new FakePinStore(),
        state: INITIAL_WATCHDOG_STATE,
        probeInternet: async () => false,
        wifi: new FakeWifiRejoiner(true),
        credsStore: new FakeWifiCredsStore(CREDS),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
      expect(sleeps.length).toBeGreaterThan(1);
    });

    it("applies the same check to the recovery rejoin after a reboot", async () => {
      const marker: RebootMarker = { at: 0, source: "watchdog", iccid: ICCID };
      const run = (script: Array<RouterModel | Error>) =>
        runWatchdogTick({
          client: client(script),
          password: null,
          pinStore: new FakePinStore(),
          state: { ...INITIAL_WATCHDOG_STATE, reboot: marker },
          probeInternet: async () => false,
          wifi: new FakeWifiRejoiner(true),
          credsStore: new FakeWifiCredsStore(CREDS),
          now: () => 10_000,
          sleep: noSleep,
        });
      const never = await run([new Error("curl exited 7")]);
      expect(never.event.kind).toBe("rejoin-failed");
      const back = await run([new Error("curl exited 7"), buildModel({})]);
      expect(back.event.kind).toBe("rejoined");
    });
  });

  describe("state migration", () => {
    const OLD_STATE = {
      internetFailures: 1,
      lastReconnectAt: 5,
      reconnectStreak: 2,
      lastRejoinAttemptAt: null,
      lastRoamingAttemptAt: null,
      stuckStreak: 0,
      dataToggledAt: null,
      lastRebootAt: null,
      reboot: null,
    };

    it("fills the battery fields of a state persisted before they existed", () => {
      expect(migrateWatchdogState(OLD_STATE)).toEqual({
        ...OLD_STATE,
        lastBattery: null,
        lowBatteryNoticeLevel: null,
        batteryEmptyAt: null,
        noServiceSince: null,
        lastNoServiceRebootAt: null,
        noServiceRebootCount: 0,
      });
      expect(migrateWatchdogState(undefined)).toEqual(INITIAL_WATCHDOG_STATE);
    });

    it("runs a tick on an old-shaped state without announcing a phantom power-restored", async () => {
      const result = await runWatchdogTick({
        client: client([batteryModel(80, true)]),
        password: "s3cr3t",
        pinStore: new FakePinStore(),
        state: OLD_STATE as WatchdogState,
        probeInternet: async () => true,
        now: () => T0,
      });
      expect(result.event.kind).toBe("ok");
      expect(result.state.lastBattery).toEqual({
        level: 80,
        charging: true,
        at: T0,
      });
      expect(result.state.batteryEmptyAt).toBeNull();
    });
  });

  describe("subtitle", () => {
    const at = Date.UTC(2026, 0, 1, 14, 2);
    it("shows the battery next to an ok while it is low and not charging", () => {
      expect(
        formatSubtitle({ at, kind: "ok", message: "OK · 4G+", batteryLow: 18 }),
      ).toMatch(/^OK · 4G\+ · 🔋18% · \d{2}:\d{2}$/);
    });

    it("leaves other kinds and a healthy battery alone", () => {
      expect(formatSubtitle({ at, kind: "ok", message: "OK · 4G+" })).toMatch(
        /^OK · 4G\+ · \d{2}:\d{2}$/,
      );
      expect(
        formatSubtitle({ at, kind: "needs-pin", message: "x", batteryLow: 5 }),
      ).toBe("SIM PIN needed");
    });

    it("shows the battery notices and power-restored", () => {
      expect(
        formatSubtitle({
          at,
          kind: "battery-low",
          message: "Router battery 18% — plug it in",
        }),
      ).toBe("🔋 Router battery 18% — plug it in");
      expect(
        formatSubtitle({
          at,
          kind: "battery-empty",
          message: "Router off — battery was 4% at 00:45. Plug it in.",
        }),
      ).toBe("🔋 Router off — battery was 4% at 00:45. Plug it in.");
      expect(
        formatSubtitle({
          at,
          kind: "power-restored",
          message: "Router back on power (battery 5%, charging)",
        }),
      ).toMatch(
        /^Router back on power \(battery 5%, charging\) · \d{2}:\d{2}$/,
      );
    });
  });
});

describe("runWatchdogTick — no mobile network (limited service)", () => {
  const T0 = Date.UTC(2026, 9, 6, 11, 0);
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  function limitedModel(connection = "Disconnected"): RouterModel {
    const model = buildModel({ connection });
    model.wwan.currentNWserviceType = "LimitedService";
    model.wwan.registerNetworkDisplay = "";
    return model;
  }

  function run(opts: {
    script: Array<RouterModel | Error>;
    state?: Partial<WatchdogState>;
    now: number;
    probe?: boolean;
  }) {
    const transport = new ScriptedNetgearHttp(opts.script);
    // The flows poll against the injected clock — a frozen one never times out.
    const clock = fakeClock(0);
    const result = runWatchdogTick({
      client: new NetgearClient({ host: "http://192.168.1.1", transport }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: { ...INITIAL_WATCHDOG_STATE, ...opts.state },
      probeInternet: async () => opts.probe ?? false,
      now: () => opts.now + clock.now(),
      sleep: clock.sleep,
    });
    return result.then((r) => ({ ...r, posts: transport.postCalls }));
  }

  it("reports no-service and does not connect, toggle or reboot", async () => {
    const result = await run({ script: [limitedModel()], now: T0 });
    expect(result.event.kind).toBe("no-service");
    expect(result.event.message).toBe(
      "No mobile network — limited service (operator not available here). Waiting for coverage.",
    );
    expect(result.posts).toEqual([]);
    expect(result.state.noServiceSince).toBe(T0);
    expect(result.event.detail).toContain("operator=n/a");
  });

  it("never connects, toggles or reboots during the first 5 minutes", async () => {
    let state: WatchdogState = INITIAL_WATCHDOG_STATE;
    for (let i = 0; i < 5; i++) {
      const result = await run({
        script: [limitedModel()],
        state,
        now: T0 + i * MIN,
      });
      expect(result.event.kind).toBe("no-service");
      expect(result.posts).toEqual([]);
      state = result.state;
    }
    expect(state.noServiceSince).toBe(T0);
  });

  it("resets the stuck ladder and keeps recording the battery", async () => {
    const model = limitedModel();
    model.power = { ...model.power, battChargeLevel: 55, charging: false };
    const result = await run({
      script: [model],
      now: T0,
      state: {
        stuckStreak: 2,
        dataToggledAt: T0 - MIN,
        reconnectStreak: 2,
        internetFailures: 1,
      },
    });
    expect(result.event.kind).toBe("no-service");
    expect(result.state).toMatchObject({
      stuckStreak: 0,
      dataToggledAt: null,
      reconnectStreak: 0,
      internetFailures: 0,
      lastBattery: { level: 55, charging: false, at: T0 },
    });
  });

  it("restarts the first time after 5 minutes of continuous no-service", async () => {
    const result = await run({
      script: [limitedModel()],
      now: T0 + 5 * MIN,
      state: { noServiceSince: T0 },
    });
    expect(result.event.kind).toBe("rebooted");
    expect(result.event.message).toBe(
      "Router stuck — restarted it (no service for 5 min)",
    );
    expect(result.posts.some((p) => "general.shutdown" in p.fields)).toBe(true);
    expect(result.state).toMatchObject({
      // Kept, so the next reason and `service-restored` see the whole outage.
      noServiceSince: T0,
      noServiceRebootCount: 1,
      lastNoServiceRebootAt: T0 + 5 * MIN,
      lastRebootAt: T0 + 5 * MIN,
      reboot: { source: "watchdog", iccid: ICCID },
    });
  });

  it("does not restart just before the 5 minutes are up", async () => {
    const result = await run({
      script: [limitedModel()],
      now: T0 + 5 * MIN - 1,
      state: { noServiceSince: T0 },
    });
    expect(result.event.kind).toBe("no-service");
    expect(result.posts).toEqual([]);
  });

  it("names the actual no-service duration in the reason", async () => {
    const result = await run({
      script: [limitedModel()],
      now: T0 + 12 * MIN,
      state: { noServiceSince: T0 },
    });
    expect(result.event.message).toBe(
      "Router stuck — restarted it (no service for 12 min)",
    );
  });

  describe("escalating gaps after a restart that did not help", () => {
    // [reboots so far, gap since the last one]
    const gaps: Array<[number, number]> = [
      [1, 30 * MIN],
      [2, 2 * HOUR],
      [3, 6 * HOUR],
      [4, 6 * HOUR],
      [9, 6 * HOUR],
    ];
    const lastAt = T0 + 5 * MIN;
    const stateAfter = (count: number): Partial<WatchdogState> => ({
      noServiceSince: T0,
      noServiceRebootCount: count,
      lastNoServiceRebootAt: lastAt,
      lastRebootAt: lastAt,
    });

    it.each(gaps)(
      "after %i restart(s) waits the gap, then restarts again",
      async (count, gap) => {
        const early = await run({
          script: [limitedModel()],
          now: lastAt + gap - 1,
          state: stateAfter(count),
        });
        expect(early.event.kind).toBe("no-service");
        expect(early.posts).toEqual([]);

        const due = await run({
          script: [limitedModel()],
          now: lastAt + gap,
          state: stateAfter(count),
        });
        expect(due.event.kind).toBe("rebooted");
        expect(due.state).toMatchObject({
          noServiceRebootCount: count + 1,
          lastNoServiceRebootAt: lastAt + gap,
        });
      },
    );

    it("is not held back by the general 30-minute cooldown at the 30-minute gap", async () => {
      const result = await run({
        script: [limitedModel()],
        now: lastAt + REBOOT_COOLDOWN_MS,
        state: stateAfter(1),
      });
      expect(result.event.kind).toBe("rebooted");
    });

    it("still honours the general cooldown against any other recent reboot", async () => {
      const result = await run({
        script: [limitedModel()],
        now: T0 + 6 * MIN,
        state: { noServiceSince: T0, lastRebootAt: T0 + 2 * MIN },
      });
      expect(result.event.kind).toBe("no-service");
      expect(result.posts).toEqual([]);
    });
  });

  it("starts over with the 5-minute rule after the router registered again", async () => {
    const back = await run({
      script: [buildModel({ connection: "Connected" })],
      now: T0 + 40 * MIN,
      state: {
        noServiceSince: T0,
        noServiceRebootCount: 2,
        lastNoServiceRebootAt: T0 + 35 * MIN,
      },
      probe: true,
    });
    expect(back.state).toMatchObject({
      noServiceSince: null,
      noServiceRebootCount: 0,
    });

    // A fresh outage: no reboot until 5 minutes in, regardless of the old one.
    const fresh = await run({
      script: [limitedModel()],
      now: T0 + 2 * HOUR + 5 * MIN,
      state: {
        ...back.state,
        noServiceSince: T0 + 2 * HOUR,
      },
    });
    expect(fresh.event.kind).toBe("rebooted");
    expect(fresh.state.noServiceRebootCount).toBe(1);
  });

  it("counts a failed restart attempt too", async () => {
    const transport = new ScriptedNetgearHttp(
      [limitedModel()],
      ['{ "errno": , "errdetail": "" }'],
    );
    const clock = fakeClock(0);
    const result = await runWatchdogTick({
      client: new NetgearClient({ host: "http://192.168.1.1", transport }),
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      state: { ...INITIAL_WATCHDOG_STATE, noServiceSince: T0 },
      probeInternet: async () => false,
      now: () => T0 + 5 * MIN + clock.now(),
      sleep: clock.sleep,
    });
    expect(result.event.kind).toBe("error");
    expect(result.state).toMatchObject({
      noServiceRebootCount: 1,
      lastNoServiceRebootAt: T0 + 5 * MIN,
    });
  });

  it("migrates persisted state without a restart count to 0", () => {
    const old: Partial<WatchdogState> = { ...INITIAL_WATCHDOG_STATE };
    delete old.noServiceRebootCount;
    expect(migrateWatchdogState(old).noServiceRebootCount).toBe(0);
    expect(migrateWatchdogState(undefined).noServiceRebootCount).toBe(0);
  });

  it("does not reboot while a reboot marker is still active", async () => {
    const model = limitedModel();
    model.general = { upTime: 10 * 86_400 }; // still the old session
    const result = await run({
      script: [model],
      now: T0 + 2 * HOUR,
      state: {
        noServiceSince: T0,
        reboot: { at: T0 + 2 * HOUR - MIN, source: "ui", iccid: ICCID },
      },
    });
    expect(result.event.kind).toBe("no-service");
    expect(result.posts).toEqual([]);
  });

  it("never reboots without a Ready SIM", async () => {
    const model = limitedModel();
    model.sim = { ...model.sim, status: "NotPresent" };
    const result = await run({
      script: [model],
      now: T0 + 2 * HOUR,
      state: { noServiceSince: T0 },
    });
    expect(result.event.kind).toBe("sim-problem");
    expect(result.posts).toEqual([]);
  });

  it("drops the reboot marker once the router is back up, still without service", async () => {
    const model = limitedModel();
    model.general = { upTime: 30 };
    const result = await run({
      script: [model],
      now: T0 + 3 * MIN,
      state: { reboot: { at: T0, source: "watchdog", iccid: ICCID } },
    });
    expect(result.event.kind).toBe("no-service");
    expect(result.state.reboot).toBeNull();
  });

  it("announces service-restored once, then runs the normal flow in the same tick", async () => {
    const back = buildModel({ connection: "Connected" });
    const result = await run({
      script: [back],
      now: T0 + 20 * MIN,
      state: { noServiceSince: T0, stuckStreak: 0 },
      probe: true,
    });
    expect(result.event.kind).toBe("service-restored");
    expect(result.event.message).toBe("Mobile network back (Fakecom, LTE B7)");
    expect(result.state.noServiceSince).toBeNull();

    const next = await run({
      script: [back],
      now: T0 + 21 * MIN,
      state: result.state,
      probe: true,
    });
    expect(next.event.kind).toBe("ok");
  });

  it("runs the normal connect in the restoring tick, keeping it as detail", async () => {
    const back = buildModel({ connection: "Disconnected" });
    const connected = buildModel({ connection: "Connected" });
    const result = await run({
      script: [back, back, connected],
      now: T0 + 20 * MIN,
      state: { noServiceSince: T0 },
      probe: true,
    });
    expect(result.event.kind).toBe("service-restored");
    expect(result.event.detail).toContain("connected: Connected");
    expect(result.state.noServiceSince).toBeNull();
  });

  it("collapses consecutive no-service ticks in the log", () => {
    const at = (n: number): WatchdogEvent => ({
      at: T0 + n * MIN,
      kind: "no-service",
      message: "No mobile network — limited service",
    });
    let log = { events: [], counts: {}, since: null } as Parameters<
      typeof appendWatchdogEvent
    >[0];
    for (let i = 0; i < 5; i++) log = appendWatchdogEvent(log, at(i));
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({ count: 5, firstAt: T0 });
  });

  it("shows the subtitle as 'No service · HH:MM'", () => {
    expect(
      formatSubtitle({ at: T0, kind: "no-service", message: "x" }),
    ).toMatch(/^No service · \d{2}:\d{2}$/);
    expect(
      formatSubtitle({
        at: T0,
        kind: "service-restored",
        message: "Mobile network back (Fakecom, LTE B7)",
      }),
    ).toMatch(/^Mobile network back \(Fakecom, LTE B7\) · \d{2}:\d{2}$/);
  });
});
