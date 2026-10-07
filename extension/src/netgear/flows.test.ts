import { describe, it, expect } from "vitest";
import { NetgearClient, parseStatus } from "./client";
import { NetgearHttpResponse, RouterModel, RouterStatus } from "./types";
import { WifiCredentials, WifiRejoiner } from "./wifi";
import {
  shouldAutoEnterPin,
  resolveAutoUnlockPin,
  autoUnlockIfPossible,
  unlockSim,
  reconnect,
  ensureConnected,
  rebootAndReconnect,
  ensureRouterReachable,
  toggleData,
  SimPinRequiredError,
  NO_SERVICE_ERROR_MESSAGE,
} from "./flows";
import { ROUTER_UNREACHABLE_MESSAGE, describeNetgearError } from "./errors";
import {
  ICCID,
  BASE_STATUS,
  buildModel,
  ScriptedNetgearHttp,
  DataRouterHttp,
  FakePinStore,
  FakeWifiCredsStore,
  FakeWifiRejoiner,
  fakeClock,
  REJECTED_BODY,
  SUCCESS_BODY,
} from "./test-helpers";

describe("shouldAutoEnterPin", () => {
  function statusWith(fields: {
    simStatus: string;
    iccid: string;
    simPinRetry: number;
  }): RouterStatus {
    return { ...BASE_STATUS, ...fields };
  }
  const locked = (retry: number, iccid = ICCID) =>
    statusWith({ simStatus: "Locked", iccid, simPinRetry: retry });

  it("is false when the SIM is Ready", () => {
    const status = statusWith({
      simStatus: "Ready",
      iccid: ICCID,
      simPinRetry: 3,
    });
    expect(shouldAutoEnterPin(status, "1234")).toBe(false);
  });

  it("is false with no stored PIN", () => {
    expect(shouldAutoEnterPin(locked(3), null)).toBe(false);
  });

  it("needs every attempt left for a fallback PIN", () => {
    expect(shouldAutoEnterPin(locked(2, ""), "1234", { fallback: true })).toBe(
      false,
    );
    expect(shouldAutoEnterPin(locked(3, ""), "1234", { fallback: true })).toBe(
      true,
    );
  });

  it("is false at the last retry (retry 1) — never burn the final attempt", () => {
    expect(shouldAutoEnterPin(locked(1), "1234")).toBe(false);
  });

  it("is true when Locked, PIN stored, and retries >= 2", () => {
    expect(shouldAutoEnterPin(locked(2), "1234")).toBe(true);
    expect(shouldAutoEnterPin(locked(3), "1234")).toBe(true);
  });
});

describe("unlockSim", () => {
  it("stores the PIN under the SIM's iccid on success", async () => {
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
    });
    const transport = new ScriptedNetgearHttp([locked, ready]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const pinStore = new FakePinStore();
    const clock = fakeClock(2000);

    const status = await unlockSim({
      client,
      pin: "1234",
      pinStore,
      remember: true,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(status.simStatus).toBe("Ready");
    expect(pinStore.setCalls).toEqual([{ iccid: ICCID, pin: "1234" }]);
  });

  it("deletes any stored PIN and throws when the PIN is rejected", async () => {
    const lockedRetry2 = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 2 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const lockedRetry1 = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 1 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const transport = new ScriptedNetgearHttp([lockedRetry2, lockedRetry1]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const pinStore = new FakePinStore({ [ICCID]: "0000" });
    const clock = fakeClock(2000);

    await expect(
      unlockSim({
        client,
        pin: "9999",
        pinStore,
        remember: true,
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(/SIM PIN was not accepted/);

    expect(pinStore.deleteCalls).toEqual([ICCID]);
  });

  it("keeps the stored PIN when the SIM is still Locked but no retry was burned", async () => {
    const lockedRetry3 = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const transport = new ScriptedNetgearHttp([lockedRetry3]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const pinStore = new FakePinStore({ [ICCID]: "1234" });
    const clock = fakeClock(2000);

    await expect(
      unlockSim({
        client,
        pin: "1234",
        pinStore,
        remember: true,
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(/SIM PIN was not accepted/);

    expect(pinStore.deleteCalls).toEqual([]);
  });
});

describe("reconnect", () => {
  it("disconnects, waits for Disconnected, connects, waits for Connected", async () => {
    const connected = buildModel({ connection: "Connected" });
    const disconnected = buildModel({ connection: "Disconnected" });
    const transport = new ScriptedNetgearHttp([
      connected, // initial state read
      connected, // disconnect() token fetch
      disconnected, // pollUntil(Disconnected) — done immediately
      disconnected, // connect() token fetch
      connected, // pollUntil(Connected) — done immediately
    ]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const clock = fakeClock(2000);

    const status = await reconnect({
      client,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(status.connection).toBe("Connected");
  });

  it("throws with the last seen state on a disconnect timeout", async () => {
    const connecting = buildModel({ connection: "Connecting" });
    const transport = new ScriptedNetgearHttp([connecting]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const clock = fakeClock(2000);

    await expect(
      reconnect({ client, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(/Timed out waiting to disconnect/);
  });
});

describe("toggleData", () => {
  function setup(opts: ConstructorParameters<typeof DataRouterHttp>[0]) {
    const transport = new DataRouterHttp(opts);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    return { transport, client, clock: fakeClock(2000) };
  }

  it("switches data off, waits for Disconnected, restores Always and returns Connected", async () => {
    const { transport, client, clock } = setup({});
    const status = await toggleData({
      client,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(status.connection).toBe("Connected");
    expect(transport.autoconnectWrites).toEqual(["Never", "Always"]);
    expect(transport.autoconnect).toBe("Always");
  });

  it("restores Always even when the off-poll fails", async () => {
    const { transport, client, clock } = setup({ dropOnNever: false });
    await expect(
      toggleData({ client, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(/Timed out waiting for data to switch off/);
    expect(transport.autoconnectWrites).toEqual(["Never", "Always"]);
    expect(transport.autoconnect).toBe("Always");
  });

  it("restores Always when the Never request itself is refused", async () => {
    const transport = new ScriptedNetgearHttp(
      [buildModel({ connection: "Connected" })],
      [REJECTED_BODY, SUCCESS_BODY],
    );
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const clock = fakeClock(2000);
    await expect(
      toggleData({ client, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(/Router rejected the data request/);
    expect(
      transport.postCalls.map((c) => c.fields["wwan.autoconnect"]),
    ).toEqual(["Never", "Always"]);
  });

  it("throws a clear error when the router does not come back Connected", async () => {
    const { transport, client, clock } = setup({
      stuck: true,
      toggleFixes: false,
    });
    await expect(
      toggleData({ client, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(
      /Timed out waiting to connect after the data reset \(last state: Disconnected\)/,
    );
    expect(transport.autoconnect).toBe("Always");
  });

  it("honours the scaled timeouts", async () => {
    const { client, clock } = setup({ dropOnNever: false });
    let elapsed = 0;
    await expect(
      toggleData({
        client,
        sleep: clock.sleep,
        now: () => (elapsed = clock.now()),
        timeouts: { dataOffMs: 4000, connectMs: 6000 },
      }),
    ).rejects.toThrow();
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe("reconnect — state-aware", () => {
  const connected = buildModel({ connection: "Connected" });
  const connecting = buildModel({ connection: "Connecting" });
  const disconnecting = buildModel({ connection: "Disconnecting" });
  const disconnected = buildModel({ connection: "Disconnected" });

  function run(script: Array<RouterModel | Error>, postBodies?: string[]) {
    const transport = new ScriptedNetgearHttp(script, postBodies);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const clock = fakeClock(2000);
    const result = reconnect({ client, sleep: clock.sleep, now: clock.now });
    // Which router actions went out, in order.
    const actions = () =>
      transport.postCalls.map((c) =>
        c.fields["wwan.connect"] === "0" ? "disconnect" : "connect",
      );
    return { result, actions };
  }

  it("Disconnected: skips the disconnect and only connects", async () => {
    const { result, actions } = run([
      disconnected, // initial state read
      disconnected, // connect() token fetch
      connected, // pollUntil(Connected)
    ]);
    expect((await result).connection).toBe("Connected");
    expect(actions()).toEqual(["connect"]);
  });

  it("Disconnecting: waits for Disconnected without sending a disconnect", async () => {
    const { result, actions } = run([
      disconnecting, // initial state read
      disconnecting, // pollUntil(Disconnected) — still going down
      disconnected, // pollUntil(Disconnected) — done
      disconnected, // connect() token fetch
      connected,
    ]);
    expect((await result).connection).toBe("Connected");
    expect(actions()).toEqual(["connect"]);
  });

  it("Connecting: returns the finished connection without cycling it", async () => {
    const { result, actions } = run([
      connecting, // initial state read
      connecting, // pollUntil(Connected) — not yet
      connected, // pollUntil(Connected) — done
    ]);
    expect((await result).connection).toBe("Connected");
    expect(actions()).toEqual([]);
  });

  it("Connecting that never finishes: falls through to disconnect + connect", async () => {
    const { result, actions } = run([
      // initial read + the whole connect poll (60s / 2s steps) stay Connecting
      ...Array.from({ length: 40 }, () => connecting),
      connecting, // disconnect() token fetch
      disconnected, // pollUntil(Disconnected)
      disconnected, // connect() token fetch
      connected,
    ]);
    expect((await result).connection).toBe("Connected");
    expect(actions()).toEqual(["disconnect", "connect"]);
  });

  it("Connected: disconnects, then connects", async () => {
    const { result, actions } = run([
      connected, // initial state read
      connected, // disconnect() token fetch
      disconnected, // pollUntil(Disconnected)
      disconnected, // connect() token fetch
      connected,
    ]);
    expect((await result).connection).toBe("Connected");
    expect(actions()).toEqual(["disconnect", "connect"]);
  });

  it("tolerates a rejected disconnect when the router is already disconnecting", async () => {
    const { result, actions } = run(
      [
        connected, // initial state read
        connected, // disconnect() token fetch
        disconnecting, // re-read after the rejection
        disconnected, // pollUntil(Disconnected)
        disconnected, // connect() token fetch
        connected,
      ],
      [REJECTED_BODY, SUCCESS_BODY],
    );
    expect((await result).connection).toBe("Connected");
    expect(actions()).toEqual(["disconnect", "connect"]);
  });

  it("rethrows a rejected disconnect when the router is still Connected", async () => {
    const { result } = run(
      [
        connected, // initial state read
        connected, // disconnect() token fetch
        connected, // re-read after the rejection — nothing moved
      ],
      [REJECTED_BODY],
    );
    await expect(result).rejects.toThrow(/Router rejected the disconnect/);
  });

  it("tolerates a rejected connect when the router is already connecting", async () => {
    const { result, actions } = run(
      [
        disconnected, // initial state read
        disconnected, // connect() token fetch
        connecting, // re-read after the rejection
        connected, // pollUntil(Connected)
      ],
      [REJECTED_BODY],
    );
    expect((await result).connection).toBe("Connected");
    expect(actions()).toEqual(["connect"]);
  });

  it("rethrows a rejected connect when the router is still Disconnected", async () => {
    const { result } = run(
      [
        disconnected, // initial state read
        disconnected, // connect() token fetch
        disconnected, // re-read after the rejection
      ],
      [REJECTED_BODY],
    );
    await expect(result).rejects.toThrow(/Router rejected the connect/);
  });
});

describe("ensureConnected", () => {
  const connected = buildModel({ connection: "Connected" });
  const disconnected = buildModel({ connection: "Disconnected" });
  const connecting = buildModel({ connection: "Connecting" });

  it("tolerates a rejected connect when the router is already connecting", async () => {
    const transport = new ScriptedNetgearHttp(
      [
        ...Array.from({ length: 10 }, () => disconnected), // check poll (20s / 2s steps)
        disconnected, // connect() token fetch
        connecting, // re-read after the rejection
        connected, // pollUntil(Connected)
      ],
      [REJECTED_BODY],
    );
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const clock = fakeClock(2000);

    const status = await ensureConnected({
      client,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(status.connection).toBe("Connected");
  });

  it("rethrows a rejected connect when nothing is moving", async () => {
    const transport = new ScriptedNetgearHttp([disconnected], [REJECTED_BODY]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const clock = fakeClock(2000);

    await expect(
      ensureConnected({ client, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(/Router rejected the connect/);
  });
});

describe("no mobile network (limited service)", () => {
  function limited(connection = "Disconnected"): RouterModel {
    const model = buildModel({ connection });
    model.wwan.currentNWserviceType = "LimitedService";
    model.wwan.registerNetworkDisplay = "";
    return model;
  }

  function setup(script: RouterModel[]) {
    const transport = new ScriptedNetgearHttp(script);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    return { transport, client, clock: fakeClock(2000) };
  }

  it("reconnect fails at once without disconnecting, connecting or polling", async () => {
    const { transport, client, clock } = setup([limited("Connecting")]);

    await expect(
      reconnect({ client, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(NO_SERVICE_ERROR_MESSAGE);
    expect(transport.postCalls).toEqual([]);
    expect(clock.now()).toBe(0);
  });

  it("ensureConnected gives a just-unlocked SIM the check window, then fails without connecting", async () => {
    const { transport, client, clock } = setup([limited()]);

    await expect(
      ensureConnected({ client, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(NO_SERVICE_ERROR_MESSAGE);
    expect(transport.postCalls).toEqual([]);
    // Only the 20s check poll ran — not the 90s connect poll.
    expect(clock.now()).toBeLessThanOrEqual(2000 + 22_000);
  });

  it("ensureConnected still succeeds when the SIM registers during the check window", async () => {
    const { client, clock } = setup([
      limited(),
      buildModel({ connection: "Connected" }),
    ]);

    const status = await ensureConnected({
      client,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(status.connection).toBe("Connected");
  });

  it("does not blame the network while the SIM is locked", async () => {
    const locked = limited();
    locked.sim = { ...locked.sim, status: "Locked" };
    const { client, clock } = setup([locked]);

    await expect(
      reconnect({ client, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(/Timed out waiting to connect/);
  });

  it("keeps the message as-is in describeNetgearError", () => {
    expect(describeNetgearError(new Error(NO_SERVICE_ERROR_MESSAGE))).toBe(
      NO_SERVICE_ERROR_MESSAGE,
    );
  });
});

describe("rebootAndReconnect", () => {
  it("survives an unreachable phase, auto-unlocks the SIM, and reconnects", async () => {
    const preReboot = buildModel({ connection: "Connected" });
    const postReboot = buildModel({ connection: "Disconnected" });
    const lockedAfterLogin = buildModel({
      connection: "Disconnected",
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const readyAfterUnlock = buildModel({
      connection: "Disconnected",
      sim: {
        status: "Ready",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });
    const connectedFinal = buildModel({
      connection: "Connected",
      sim: {
        status: "Ready",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });

    const transport = new ScriptedNetgearHttp([
      preReboot, // pre-reboot ICCID capture
      preReboot, // 0: reboot() token fetch
      new Error("ECONNREFUSED"), // 1: pollUntilUnreachable — goes down
      new Error("ECONNREFUSED"), // 2: pollUntilReachable attempt 1 — still down
      postReboot, // 3: pollUntilReachable attempt 2 — back up
      postReboot, // 4: login() token fetch
      lockedAfterLogin, // 5: login()'s getStatus
      lockedAfterLogin, // 6: SIM-settle poll — Locked is terminal, done
      lockedAfterLogin, // 7: unlockSim's "before" getStatus
      lockedAfterLogin, // 8: enterSimPin() token fetch
      readyAfterUnlock, // 9: unlockSim's pollUntil(Ready) — done
      readyAfterUnlock, // 10: post-unlock ≤20s Connected check — still Disconnected
      readyAfterUnlock, // 11: connect() token fetch
      connectedFinal, // 12: final pollUntil(Connected) — done
    ]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const pinStore = new FakePinStore({ [ICCID]: "4321" });
    const progress: string[] = [];
    // A 20s step matches the ≤20s "is it already connected" check exactly,
    // so that phase resolves after its one scripted (still-Disconnected)
    // reading instead of looping — see the derivation in the PR/brief.
    const clock = fakeClock(20_000);

    const status = await rebootAndReconnect({
      client,
      password: "s3cr3t",
      pinStore,
      onProgress: (m) => progress.push(m),
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(status.connection).toBe("Connected");
    expect(status.simStatus).toBe("Ready");
    expect(progress).toContain("Rebooting router…");
    expect(progress.some((m) => m.includes("auto-unlock"))).toBe(true);
  });

  it("throws SimPinRequiredError when no PIN is saved for a locked SIM", async () => {
    const preReboot = buildModel({ connection: "Connected" });
    const postReboot = buildModel({ connection: "Disconnected" });
    const lockedAfterLogin = buildModel({
      connection: "Disconnected",
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: ICCID,
      },
    });

    const transport = new ScriptedNetgearHttp([
      preReboot,
      preReboot,
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      postReboot,
      postReboot,
      lockedAfterLogin,
      lockedAfterLogin,
    ]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const pinStore = new FakePinStore(); // nothing saved
    const clock = fakeClock(20_000);

    await expect(
      rebootAndReconnect({
        client,
        password: "s3cr3t",
        pinStore,
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toBeInstanceOf(SimPinRequiredError);
  });

  it("rejoins the Mac to the router's Wi-Fi while the router stays unreachable", async () => {
    const withWifi: RouterModel = {
      ...buildModel({ connection: "Connected" }),
      wifi: { SSID: "FakeNet", passPhrase: "fake-passphrase" },
    };
    const connected = buildModel({ connection: "Connected" });
    const down = new Error("curl exited 7");

    const transport = new ScriptedNetgearHttp([
      withWifi, // pre-reboot ICCID capture
      withWifi, // getWifiCredentials()
      withWifi, // reboot() token fetch
      down, // pollUntilUnreachable — goes down
      ...Array.from({ length: 4 }, () => down), // Mac still off the LAN
      connected, // back up
      connected, // login() token fetch
      connected, // login()'s getStatus
      connected, // SIM settle — Ready + Connected, done
    ]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const rejoins: WifiCredentials[] = [];
    const wifi: WifiRejoiner = {
      rejoin: async (creds) => {
        rejoins.push(creds);
        return true;
      },
    };
    const clock = fakeClock(5_000);

    const status = await rebootAndReconnect({
      client,
      password: "s3cr3t",
      pinStore: new FakePinStore(),
      wifi,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(status.connection).toBe("Connected");
    expect(rejoins.length).toBeGreaterThanOrEqual(1);
    expect(rejoins[0]).toEqual({
      ssid: "FakeNet",
      passphrase: "fake-passphrase",
    });
  });
});

describe("pollUntil tolerance", () => {
  it("rides out a transient transport error mid-reconnect", async () => {
    const connected = buildModel({ connection: "Connected" });
    const disconnected = buildModel({ connection: "Disconnected" });
    const transport = new ScriptedNetgearHttp([
      connected, // initial state read
      connected, // disconnect() token fetch
      new Error("curl exited 28"), // LAN hiccup during the poll
      disconnected,
      disconnected, // connect() token fetch
      connected,
    ]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const clock = fakeClock(1000);

    const status = await reconnect({
      client,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(status.connection).toBe("Connected");
  });
});

describe("resolveAutoUnlockPin", () => {
  const lockedHidden = (retry: number): RouterStatus => ({
    ...BASE_STATUS,
    simStatus: "Locked",
    iccid: "",
    simPinRetry: retry,
  });

  it("uses a caller-known ICCID when the Locked status hides it", async () => {
    const pinStore = new FakePinStore({ [ICCID]: "1234" });
    expect(
      await resolveAutoUnlockPin({
        status: lockedHidden(2),
        pinStore,
        knownIccid: ICCID,
      }),
    ).toEqual({ pin: "1234", iccid: ICCID, fallback: false });
  });

  it("falls back to the last-seen SIM only with every attempt left", async () => {
    const pinStore = new FakePinStore({ [ICCID]: "1234" });
    pinStore.lastIccid = ICCID;
    expect(
      await resolveAutoUnlockPin({ status: lockedHidden(3), pinStore }),
    ).toEqual({ pin: "1234", iccid: ICCID, fallback: true });
    expect(
      await resolveAutoUnlockPin({ status: lockedHidden(2), pinStore }),
    ).toBeNull();
  });

  it("is null with no identity at all", async () => {
    expect(
      await resolveAutoUnlockPin({
        status: lockedHidden(3),
        pinStore: new FakePinStore(),
      }),
    ).toBeNull();
  });
});

describe("unlockSim — slow router", () => {
  it("treats an unanswered PIN request as unknown and trusts the SIM state", async () => {
    const locked = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: "",
      },
    });
    const ready = buildModel({});
    class TimeoutOnPost extends ScriptedNetgearHttp {
      async postForm(): Promise<NetgearHttpResponse> {
        throw new Error("curl exited 28: Operation timed out");
      }
    }
    const transport = new TimeoutOnPost([locked, locked, ready]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const pinStore = new FakePinStore();
    const clock = fakeClock(2000);

    const status = await unlockSim({
      client,
      pin: "1234",
      pinStore,
      remember: true,
      iccid: ICCID,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(status.simStatus).toBe("Ready");
    expect(pinStore.setCalls).toEqual([{ iccid: ICCID, pin: "1234" }]);
    expect(pinStore.lastIccid).toBe(ICCID);
  });
});

describe("autoUnlockIfPossible — one automatic attempt per saved PIN", () => {
  it("deletes the saved PIN when the attempt doesn't end Ready, even with no retry burned", async () => {
    const locked = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: "",
      },
    });
    const transport = new ScriptedNetgearHttp([locked]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const pinStore = new FakePinStore({ [ICCID]: "1234" });
    const clock = fakeClock(5000);

    await expect(
      autoUnlockIfPossible({
        client,
        pinStore,
        status: parseStatus(locked),
        knownIccid: ICCID,
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(/SIM PIN was not accepted/);

    expect(pinStore.deleteCalls).toEqual([ICCID]);
    expect(
      await autoUnlockIfPossible({
        client,
        pinStore,
        status: parseStatus(locked),
        knownIccid: ICCID,
      }),
    ).toBeNull();
    expect(transport.postCalls).toHaveLength(1);
  });
});

describe("autoUnlockIfPossible — concurrent attempts", () => {
  it("lets only one of two simultaneous automatic attempts enter the PIN", async () => {
    const locked = buildModel({
      sim: {
        status: "Locked",
        pin: { mode: "Enabled", retry: 3 },
        puk: { retry: 10 },
        iccid: "",
      },
    });
    const ready = buildModel({});
    const transport = new ScriptedNetgearHttp([locked, locked, ready]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const pinStore = new FakePinStore({ [ICCID]: "1234" });
    const status = parseStatus(locked);
    const clock = fakeClock(2000);
    const opts = {
      client,
      pinStore,
      status,
      knownIccid: ICCID,
      sleep: clock.sleep,
      now: clock.now,
    };

    const [a, b] = await Promise.all([
      autoUnlockIfPossible(opts),
      autoUnlockIfPossible(opts),
    ]);

    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(transport.postCalls).toHaveLength(1);
    expect(await pinStore.get(ICCID)).toBe("1234"); // written back on Ready
  });
});

describe("ensureRouterReachable", () => {
  function client(
    script: ConstructorParameters<typeof ScriptedNetgearHttp>[0],
  ) {
    return new NetgearClient({
      host: "http://192.168.1.1",
      transport: new ScriptedNetgearHttp(script),
    });
  }

  it("does nothing when the router already answers", async () => {
    const wifi = new FakeWifiRejoiner();
    const credsStore = new FakeWifiCredsStore();
    await ensureRouterReachable({
      client: client([buildModel({})]),
      wifi,
      credsStore,
    });
    expect(wifi.rejoinCalls).toHaveLength(0);
  });

  it("throws the friendly unreachable message with no stored credentials", async () => {
    const wifi = new FakeWifiRejoiner();
    const credsStore = new FakeWifiCredsStore(null);
    await expect(
      ensureRouterReachable({
        client: client([new Error("curl exited 7")]),
        wifi,
        credsStore,
      }),
    ).rejects.toThrow(ROUTER_UNREACHABLE_MESSAGE);
    expect(wifi.rejoinCalls).toHaveLength(0);
  });

  it("rejoins with the stored credentials and succeeds once the router answers", async () => {
    const wifi = new FakeWifiRejoiner();
    const credsStore = new FakeWifiCredsStore({
      ssid: "FakeNet",
      passphrase: "fake-passphrase",
    });
    const down = new Error("curl exited 7");
    const clock = fakeClock(5000);
    await ensureRouterReachable({
      client: client([down, down, buildModel({})]),
      wifi,
      credsStore,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(wifi.rejoinCalls).toEqual([
      { ssid: "FakeNet", passphrase: "fake-passphrase" },
    ]);
  });

  it("throws when the rejoin doesn't bring the router back within 20s", async () => {
    const wifi = new FakeWifiRejoiner();
    const credsStore = new FakeWifiCredsStore({
      ssid: "FakeNet",
      passphrase: "fake-passphrase",
    });
    const down = new Error("curl exited 7");
    const clock = fakeClock(5000);
    await expect(
      ensureRouterReachable({
        client: client([down]),
        wifi,
        credsStore,
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(ROUTER_UNREACHABLE_MESSAGE);
    expect(wifi.rejoinCalls).toHaveLength(1);
  });
});
