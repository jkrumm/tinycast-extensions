// Integration suite against the in-process fake router (fake-router.ts) using
// the REAL curl transport over 127.0.0.1 — the closest thing to the device
// that is safe to run in `make check`. Never touches the real router: every
// test asserts its fake's URL is loopback.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NetgearClient } from "./client";
import { CurlNetgearHttp } from "./transport";
import { FakeRouter, startFakeRouter } from "./fake-router";
import { rebootAndReconnect, reconnect, SimPinRequiredError } from "./flows";
import { findCreatedProfile } from "./apn-model";
import {
  INITIAL_WATCHDOG_STATE,
  runWatchdogTick,
  WatchdogState,
} from "./watchdog";
import {
  FakePinStore,
  FakeWifiCredsStore,
  FakeWifiRejoiner,
  ICCID,
} from "./test-helpers";

const PASSWORD = "fake";
const fastSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 10)));
const FLOW_TIMEOUTS = { connectMs: 5000, disconnectMs: 5000 };

let fake: FakeRouter;
let jarDir: string;
let client: NetgearClient;

function newClient(): NetgearClient {
  return new NetgearClient({
    host: fake.url,
    transport: new CurlNetgearHttp(join(jarDir, `jar-${Math.random()}`)),
  });
}

beforeEach(async () => {
  fake = await startFakeRouter({
    password: PASSWORD,
    delays: { connectMs: 40, disconnectMs: 40, rebootMs: 300 },
  });
  expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  jarDir = mkdtempSync(join(tmpdir(), "fake-router-test-"));
  client = newClient();
});

afterEach(async () => {
  await fake.close();
  rmSync(jarDir, { recursive: true, force: true });
});

async function profile(id: string) {
  const found = (await client.getStatus()).profiles.find((p) => p.id === id);
  if (!found) throw new Error(`no profile ${id}`);
  return found;
}

describe("session and login", () => {
  it("starts as Guest: no profiles, no Wi-Fi passphrase", async () => {
    const status = await client.getStatus();
    expect(status.userRole).toBe("Guest");
    expect(status.profiles).toEqual([]);
    expect(status.activeProfileId).toBe("");
    expect(await client.getWifiCredentials()).toBeNull();
  });

  it("logs in with the password and exposes the Admin model", async () => {
    const status = await client.login(PASSWORD);
    expect(status.userRole).toBe("Admin");
    expect(status.profiles.map((p) => p.id)).toEqual([
      "1",
      "Locked Carrier 1",
      "No Roaming 2",
    ]);
    expect(status.activeProfileId).toBe("1");
    expect(await client.getWifiCredentials()).toMatchObject({
      ssid: "FakeWifi",
    });
  });

  it("throws a clear error and stays Guest after a wrong password", async () => {
    await expect(client.login("nope")).rejects.toThrow(/login failed/);
    expect((await client.getStatus()).userRole).toBe("Guest");
  });

  // The real M2 treats a password POST as a toggle (verified live
  // 2026-10-04) — a second login used to log the session OUT, and the next
  // action was refused with errno 1. That broke Restart & Reconnect whenever
  // the Netgear view had the shared session elevated already.
  it("logging in twice keeps the session Admin", async () => {
    await client.login(PASSWORD);
    expect((await client.login(PASSWORD)).userRole).toBe("Admin");
    expect((await client.getStatus()).userRole).toBe("Admin");
  });

  it("re-elevates and retries an action whose session was logged out", async () => {
    const jar = join(jarDir, "shared.jar");
    const client = new NetgearClient({
      host: fake.url,
      transport: new CurlNetgearHttp(jar),
    });
    const other = new CurlNetgearHttp(jar);
    await client.login(PASSWORD);
    // A second process sharing the cookie jar toggles the session to Guest.
    const model = await client.getModel();
    await other.postForm(
      `${fake.url}/Forms/config`,
      { token: model.session.secToken },
      { secretFields: { "session.password": PASSWORD } },
    );
    expect((await client.getStatus()).userRole).toBe("Guest");
    await client.setRoaming(true);
    expect((await client.getStatus()).userRole).toBe("Admin");
  });

  it("rejects a mutation from a Guest session", async () => {
    await expect(client.setRoaming(true)).rejects.toThrow(
      /^Router rejected the roaming request/,
    );
  });

  it("rejects a request carrying the wrong token", async () => {
    const transport = new CurlNetgearHttp(join(jarDir, "token-jar"));
    await new NetgearClient({ host: fake.url, transport }).login(PASSWORD);
    const res = await transport.postForm(`${fake.url}/Forms/config`, {
      "wwan.autoconnect": "HomeNetwork",
      token: "bogus",
      ok_redirect: "/success.json",
      err_redirect: "/error.json",
    });
    expect(res.body).toContain('"errno"');
    expect(fake.state.autoconnect).toBe("Always");
  });

  it("surfaces failNext as a rejected action, once", async () => {
    await client.login(PASSWORD);
    fake.failNext("/Forms/config");
    await expect(client.setRoaming(false)).rejects.toThrow(
      /^Router rejected the roaming request/,
    );
    await client.setRoaming(false);
    expect(fake.state.autoconnect).toBe("HomeNetwork");
  });
});

describe("APN profiles", () => {
  beforeEach(async () => {
    await client.login(PASSWORD);
  });

  it("creates a profile and finds it by diffing ids, even next to a name+apn twin", async () => {
    const input = {
      name: "Work",
      apn: "work.fake",
      authtype: "PAP" as const,
      username: "user",
      password: "s3cr3t",
      type: "IPV4V6" as const,
      pdproamingtype: "IPV4V6" as const,
    };
    await client.createProfile(input);
    const before = new Set(
      (await client.getStatus()).profiles.map((p) => p.id),
    );
    await client.createProfile(input); // twin with the same name+apn

    const after = (await client.getStatus()).profiles;
    const created = findCreatedProfile({
      before,
      after,
      name: "Work",
      apn: "work.fake",
    });
    expect(created).not.toBeNull();
    expect(before.has(created?.id ?? "")).toBe(false);

    await client.setActiveProfile(created?.id ?? "");
    const status = await client.getStatus();
    expect(status.activeProfileId).toBe(created?.id);
    expect(status.profiles.find((p) => p.id === created?.id)).toMatchObject({
      hasPassword: true,
      authtype: "PAP",
    });
  });

  it("never lets a profile password into RouterStatus", async () => {
    await client.createProfile({
      name: "Secret",
      apn: "secret.fake",
      authtype: "PAP",
      username: "u",
      password: "hunter2-secret",
      type: "IPV4",
      pdproamingtype: "IPV4",
    });
    expect(JSON.stringify(await client.getStatus())).not.toMatch(
      /hunter2-secret|fake-profile-secret/,
    );
  });

  it("updates a profile and keeps the password when none is sent", async () => {
    await client.createProfile({
      name: "Work",
      apn: "work.fake",
      authtype: "PAP",
      username: "user",
      password: "s3cr3t",
      type: "IPV4V6",
      pdproamingtype: "IPV4V6",
    });
    const id = "Work 3";
    const update = {
      id,
      name: "Work 2",
      apn: "work2.fake",
      username: "user2",
      authtype: "CHAP" as const,
      type: "IPV4" as const,
      pdproamingtype: "None" as const,
    };

    await client.updateProfile(update);
    const stored = () => fake.state.profiles.find((p) => p.id === id);
    expect(stored()).toMatchObject({
      name: "Work 2",
      apn: "work2.fake",
      username: "user2",
      authtype: "CHAP",
      type: "IPV4",
      pdproamingtype: "None",
      password: "s3cr3t", // untouched
    });
    const sent = fake.state.requests.at(-1)?.fields ?? {};
    expect(sent).not.toHaveProperty("profile.password");
    expect(sent).not.toHaveProperty("profile.ipaddr");

    await client.updateProfile({ ...update, password: "n3w-secret" });
    expect(stored()?.password).toBe("n3w-secret");
    expect((await profile(id)).hasPassword).toBe(true);
  });

  it("rejects deleting the active profile", async () => {
    await expect(client.deleteProfile("1")).rejects.toThrow(
      /^Router rejected the delete APN profile request/,
    );
    expect((await profile("1")).deletable).toBe(false);
  });

  it("deletes an ordinary inactive profile", async () => {
    await client.deleteProfile("No Roaming 2");
    expect((await client.getStatus()).profiles.map((p) => p.id)).toEqual([
      "1",
      "Locked Carrier 1",
    ]);
  });

  it("rejects deleting a delete-deny profile", async () => {
    for (const p of fake.state.profiles) {
      if (p.id === "No Roaming 2") p.accessControl = 4;
    }
    expect((await profile("No Roaming 2")).deletable).toBe(false);
    await expect(client.deleteProfile("No Roaming 2")).rejects.toThrow(
      /^Router rejected/,
    );
  });

  it("marks a write-deny profile not editable and refuses to update it", async () => {
    const locked = await profile("Locked Carrier 1");
    expect(locked).toMatchObject({ editable: false, deletable: true });
    await expect(
      client.updateProfile({
        id: locked.id,
        name: "Hacked",
        apn: locked.apn,
        authtype: "PAPCHAP",
        type: "IPV4V6",
        pdproamingtype: "IPV4V6",
      }),
    ).rejects.toThrow(/^Router rejected the update APN profile request/);
    expect((await profile("Locked Carrier 1")).name).toBe("Locked Carrier");
  });

  it("fixes a None roaming type by updating it to the IP type", async () => {
    const noRoaming = await profile("No Roaming 2");
    expect(noRoaming.pdpRoamingType).toBe("None");
    await client.updateProfile({
      id: noRoaming.id,
      name: noRoaming.name,
      apn: noRoaming.apn,
      username: noRoaming.username,
      authtype: "None",
      type: "IPV4",
      pdproamingtype: "IPV4",
    });
    expect((await profile("No Roaming 2")).pdpRoamingType).toBe("IPV4");
  });
});

describe("roaming", () => {
  it("writes wwan.autoconnect and reads it back as roamingAllowed", async () => {
    await client.login(PASSWORD);
    await client.setRoaming(false);
    expect(await client.getStatus()).toMatchObject({
      autoconnect: "HomeNetwork",
      roamingAllowed: false,
    });
    await client.setRoaming(true);
    expect((await client.getStatus()).roamingAllowed).toBe(true);
  });

  it("reports wwan.roaming as currentlyRoaming, with the network identity", async () => {
    fake.state.roamingNow = true;
    expect(await client.getStatus()).toMatchObject({
      currentlyRoaming: true,
      mcc: "001",
      mnc: "01",
      country: "Fakeland",
    });
  });
});

describe("flows.reconnect against the fake", () => {
  beforeEach(async () => {
    await client.login(PASSWORD);
  });

  it.each([
    "Connected",
    "Disconnected",
    "Connecting",
    "Disconnecting",
  ] as const)("ends Connected when starting from %s", async (from) => {
    fake.setConnection(from);
    const status = await reconnect({
      client,
      sleep: fastSleep,
      timeouts: FLOW_TIMEOUTS,
    });
    expect(status.connection).toBe("Connected");
  });

  it("tolerates a rejected disconnect when the router is already Disconnected", async () => {
    const disconnect = client.disconnect.bind(client);
    // The router drops the session between reconnect()'s read and its request.
    client.disconnect = async () => {
      fake.setConnection("Disconnected");
      return disconnect();
    };
    const status = await reconnect({
      client,
      sleep: fastSleep,
      timeouts: FLOW_TIMEOUTS,
    });
    expect(status.connection).toBe("Connected");
    expect(
      fake.state.requests.some((r) => r.fields["wwan.connect"] === "0"),
    ).toBe(true);
  });

  it("tolerates a rejected connect when the router is already Connecting", async () => {
    fake.setConnection("Disconnected");
    const connect = client.connect.bind(client);
    client.connect = async () => {
      fake.setConnection("Connecting");
      return connect();
    };
    const status = await reconnect({
      client,
      sleep: fastSleep,
      timeouts: FLOW_TIMEOUTS,
    });
    expect(status.connection).toBe("Connected");
  });

  it("does not tolerate a rejected disconnect that changed nothing", async () => {
    fake.failNext("/Forms/config");
    await expect(
      reconnect({ client, sleep: fastSleep, timeouts: FLOW_TIMEOUTS }),
    ).rejects.toThrow(/^Router rejected the disconnect request/);
  });
});

describe("reboot", () => {
  it("is unreachable during the reboot, then comes back Locked", async () => {
    await client.login(PASSWORD);
    await client.reboot();
    await expect(client.getModel()).rejects.toThrow(/curl exited/);
    for (let i = 0; i < 200; i++) {
      if (
        await client.getModel().then(
          () => true,
          () => false,
        )
      )
        break;
      await fastSleep(10);
    }
    const status = await client.getStatus();
    expect(status.userRole).toBe("Guest"); // the reboot dropped the session
    expect(status.simStatus).toBe("Locked");
    expect(status.iccid).toBe(""); // hidden while Locked
  });

  describe("restart value", () => {
    const shutdowns = () =>
      fake.state.requests
        .filter((r) => "general.shutdown" in r.fields)
        .map((r) => r.fields["general.shutdown"]);

    it("answers a refused value with the errno 1 / general.shutdown body", async () => {
      const transport = new CurlNetgearHttp(join(jarDir, "restart-jar"));
      const admin = new NetgearClient({ host: fake.url, transport });
      await admin.login(PASSWORD);
      const { secToken } = (await admin.getModel()).session;
      const post = (value: string) =>
        transport.postForm(`${fake.url}/Forms/config`, {
          "general.shutdown": value,
          token: secToken,
          ok_redirect: "/success.json",
          err_redirect: "/error.json",
        });
      expect(JSON.parse((await post("Restart")).body)).toEqual({
        errno: 1,
        errdetail: "general.shutdown",
      });
      expect(fake.state.rebootingUntil).toBe(0);
      expect((await post("restart")).body).toContain('"success"');
      expect(fake.state.rebootingUntil).toBeGreaterThan(Date.now());
    });

    it("reboot() sends restart and stops there when it is accepted", async () => {
      await client.login(PASSWORD);
      await client.reboot();
      expect(shutdowns()).toEqual(["restart"]);
      expect(fake.state.rebootingUntil).toBeGreaterThan(Date.now());
    });

    it("reboot() falls back to Restart when restart is refused", async () => {
      fake.state.acceptedShutdownValues = ["Restart"];
      await client.login(PASSWORD);
      await client.reboot();
      expect(shutdowns()).toEqual(["restart", "Restart"]);
      expect(fake.state.rebootingUntil).toBeGreaterThan(Date.now());
    });

    it("reboot() throws the both-variants error when both are refused", async () => {
      fake.state.acceptedShutdownValues = [];
      await client.login(PASSWORD);
      await expect(client.reboot()).rejects.toThrow(
        /^Router rejected the reboot request \(tried both variants/,
      );
      expect(shutdowns()).toEqual(["restart", "Restart"]);
      expect(fake.state.rebootingUntil).toBe(0);
    });
  });

  it("rebootAndReconnect unlocks with the saved PIN and ends Connected", async () => {
    await client.login(PASSWORD);
    const status = await rebootAndReconnect({
      client,
      password: PASSWORD,
      pinStore: new FakePinStore({ [ICCID]: fake.state.simPin }),
      sleep: fastSleep,
    });
    expect(status).toMatchObject({
      simStatus: "Ready",
      connection: "Connected",
    });
  });

  it("rebootAndReconnect asks for the PIN when none is saved", async () => {
    await client.login(PASSWORD);
    await expect(
      rebootAndReconnect({
        client,
        password: PASSWORD,
        pinStore: new FakePinStore(),
        sleep: fastSleep,
      }),
    ).rejects.toBeInstanceOf(SimPinRequiredError);
  });

  it("counts down SIM PIN retries on a wrong PIN", async () => {
    fake.state.simStatus = "Locked";
    await client.login(PASSWORD);
    await client.enterSimPin("0000");
    expect(await client.getStatus()).toMatchObject({
      simStatus: "Locked",
      simPinRetry: 2,
    });
  });
});

describe("watchdog tick against the fake", () => {
  const tick = (state = INITIAL_WATCHDOG_STATE) =>
    runWatchdogTick({
      client,
      password: PASSWORD,
      pinStore: new FakePinStore(),
      state,
      probeInternet: async () => true,
      sleep: fastSleep,
      budgetMs: 1500, // keeps the connect polls well inside a test run
    });

  it("re-enables roaming once, then carries on with a normal tick", async () => {
    fake.state.autoconnect = "HomeNetwork";

    const first = await tick();
    expect(first.event.kind).toBe("roaming-enabled");
    expect(first.event.message).toBe(
      "Data roaming re-enabled (was HomeNetwork)",
    );
    expect(fake.state.autoconnect).toBe("Always");

    const second = await tick(first.state);
    expect(second.event.kind).toBe("ok");
    const roamingWrites = fake.state.requests.filter(
      (r) => r.fields["wwan.autoconnect"] !== undefined,
    );
    expect(roamingWrites).toHaveLength(1);
  });

  it("connects a Disconnected router on the tick after the roaming fix", async () => {
    fake.state.autoconnect = "Never";
    fake.setConnection("Disconnected");

    const first = await tick();
    expect(first.event.kind).toBe("roaming-enabled");
    const second = await tick(first.state);
    expect(second.event.kind).toBe("connected");
    expect(fake.state.connection).toBe("Connected");
  });
});

describe("watchdog in-tick internet confirm against the fake", () => {
  it("reconnects a Connected router without internet within a single tick", async () => {
    fake.setConnection("Connected");
    // No internet until the router has been sent a connect/disconnect request.
    const hasReconnected = () =>
      fake.state.requests.some((r) => r.fields["wwan.connect"] !== undefined);
    let probes = 0;
    const result = await runWatchdogTick({
      client,
      password: PASSWORD,
      pinStore: new FakePinStore(),
      state: INITIAL_WATCHDOG_STATE,
      probeInternet: async () => {
        probes++;
        return hasReconnected();
      },
      sleep: fastSleep,
      budgetMs: 60_000, // leaves room for the confirm, unlike the 1500ms default above
    });

    expect(result.event.kind).toBe("reconnected");
    expect(probes).toBe(2);
    expect(result.state).toMatchObject({
      internetFailures: 0,
      reconnectStreak: 1,
    });
    expect(fake.state.connection).toBe("Connected");
  }, 20_000);
});

describe("watchdog last-resort reboot against the fake", () => {
  it("restarts a router stuck Disconnected on the second tick, never toggling data, then recovers it", async () => {
    fake.state.ignoreConnect = true;
    fake.setConnection("Disconnected");
    const pinStore = new FakePinStore({ [ICCID]: fake.state.simPin });
    const wifi = new FakeWifiRejoiner(true);
    const credsStore = new FakeWifiCredsStore({
      ssid: "FakeWifi",
      passphrase: "fake-wifi-passphrase",
    });
    // The data soft reset never runs here: it failed 2/2 live on a router
    // stuck Disconnected (see the describe below for where it still applies).
    let state: WatchdogState = INITIAL_WATCHDOG_STATE;
    const tick = async () => {
      const result = await runWatchdogTick({
        client,
        password: PASSWORD,
        pinStore,
        state,
        // The Mac's only internet is through the router: while the fake
        // is down for its restart the probe fails, so the post-restart
        // rejoin applies (it never fires while the Mac is online elsewhere).
        probeInternet: () =>
          client.getModel().then(
            () => true,
            () => false,
          ),
        sleep: fastSleep,
        budgetMs: 1500,
        wifi,
        credsStore,
      });
      state = result.state;
      return result.event.kind;
    };
    const restarts = () =>
      fake.state.requests.filter((r) => "general.shutdown" in r.fields);

    expect(await tick()).toBe("connect-failed");
    expect(restarts()).toHaveLength(0);
    expect(await tick()).toBe("rebooted");
    expect(
      fake.state.requests.filter((r) => "wwan.autoconnect" in r.fields),
    ).toHaveLength(0);
    expect(restarts().map((r) => r.fields["general.shutdown"])).toEqual([
      "restart",
    ]);
    expect(state.reboot).toMatchObject({ source: "watchdog", iccid: ICCID });

    const kinds: string[] = [];
    for (let i = 0; i < 100 && kinds.at(-1) !== "recovered"; i++) {
      kinds.push(await tick());
      await fastSleep(10);
    }
    expect(kinds.at(-1)).toBe("recovered");
    // The outage was expected: the Wi-Fi is rejoined at once — but the fake
    // is still rebooting then, so it is honestly reported as not found.
    expect(wifi.rejoinCalls.length).toBeGreaterThan(0);
    expect(kinds).toContain("rejoin-failed");
    expect(kinds).toContain("unlocked"); // marker's ICCID found the saved PIN
    expect(fake.state).toMatchObject({
      simStatus: "Ready",
      connection: "Connected",
    });
    expect(state.reboot).toBeNull();
    expect(state.stuckStreak).toBe(0);
    expect(restarts()).toHaveLength(1); // exactly one reboot
  }, 20_000);
});

describe("watchdog data off/on soft reset against the fake", () => {
  // Router Connected but without internet: the fake has no network, so
  // `ignoreConnect` doubles as the black hole (probe fails while it is set,
  // and a toggle that clears it restores both), seeded with reconnects that
  // already failed to help.
  async function noInternetWatchdog() {
    fake.state.ignoreConnect = true;
    fake.setConnection("Connected");
    const pinStore = new FakePinStore({ [ICCID]: fake.state.simPin });
    let state: WatchdogState = {
      ...INITIAL_WATCHDOG_STATE,
      reconnectStreak: 2,
    };
    const tick = async () => {
      const result = await runWatchdogTick({
        client,
        password: PASSWORD,
        pinStore,
        state,
        probeInternet: async () => !fake.state.ignoreConnect,
        sleep: fastSleep,
        budgetMs: 1500,
      });
      state = result.state;
      return result.event.kind;
    };
    const autoconnectWrites = () =>
      fake.state.requests
        .map((r) => r.fields["wwan.autoconnect"])
        .filter((v) => v !== undefined);
    const restarts = () =>
      fake.state.requests.filter((r) => "general.shutdown" in r.fields);
    return { tick, autoconnectWrites, restarts, getState: () => state };
  }

  it("fixes a stuck router with the toggle on tick 2, no reboot", async () => {
    const { tick, autoconnectWrites, restarts, getState } =
      await noInternetWatchdog();

    expect(await tick()).toBe("probe-failed");
    expect(await tick()).toBe("data-toggled");
    expect(autoconnectWrites()).toEqual(["Never", "Always"]);
    expect(fake.state.autoconnect).toBe("Always");
    expect(fake.state.ignoreConnect).toBe(false);
    expect(fake.state.connection).toBe("Connected");

    expect(await tick()).toBe("ok");
    expect(getState()).toMatchObject({ stuckStreak: 0, dataToggledAt: null });
    expect(restarts()).toHaveLength(0);
  }, 20_000);

  it("reboots on tick 3 when the toggle does not help", async () => {
    fake.state.dataToggleClearsStuck = false;
    const { tick, autoconnectWrites, restarts } = await noInternetWatchdog();

    expect(await tick()).toBe("probe-failed");
    expect(await tick()).toBe("data-toggle-failed");
    expect(autoconnectWrites()).toEqual(["Never", "Always"]);
    expect(fake.state.autoconnect).toBe("Always"); // never left off
    expect(restarts()).toHaveLength(0);

    expect(await tick()).toBe("rebooted");
    expect(autoconnectWrites()).toEqual(["Never", "Always"]); // toggled once
    expect(restarts()).toHaveLength(1);
  }, 20_000);
});

describe("watchdog battery awareness against the fake", () => {
  it("reports an empty router once, skips needless rejoins, and announces power-restored", async () => {
    const pinStore = new FakePinStore({ [ICCID]: fake.state.simPin });
    const wifi = new FakeWifiRejoiner(true);
    const credsStore = new FakeWifiCredsStore({
      ssid: "FakeWifi",
      passphrase: "fake-wifi-passphrase",
    });
    // The Mac has internet only through the router.
    let routerUp = true;
    let state: WatchdogState = INITIAL_WATCHDOG_STATE;
    const tick = async () => {
      const result = await runWatchdogTick({
        client,
        password: PASSWORD,
        pinStore,
        state,
        probeInternet: async () => routerUp,
        sleep: fastSleep,
        budgetMs: 1500,
        wifi,
        credsStore,
      });
      state = result.state;
      return result.event;
    };

    // The last status before the battery dies: 4%, not charging.
    fake.state.battChargeLevel = 4;
    fake.state.charging = false;
    expect((await tick()).kind).toBe("battery-low");
    expect(state.lastBattery).toMatchObject({ level: 4, charging: false });

    // The router dies.
    fake.state.rebootingUntil = Date.now() + 3_600_000;
    routerUp = false;
    const first = await tick();
    expect(first.kind).toBe("battery-empty");
    expect(first.message).toMatch(/battery was 4% at \d{2}:\d{2}/);
    const second = await tick();
    expect(second.kind).toBe("battery-empty");
    expect(second.message).toBe(first.message);
    // One Wi-Fi look (the first tick), none inside the 30-minute backoff.
    expect(wifi.rejoinCalls).toHaveLength(1);

    // Plugged in.
    fake.state.rebootingUntil = 0;
    fake.state.battChargeLevel = 5;
    fake.state.charging = true;
    routerUp = true;
    const restored = await tick();
    expect(restored.kind).toBe("power-restored");
    expect(restored.message).toBe(
      "Router back on power (battery 5%, charging)",
    );
    expect(state.batteryEmptyAt).toBeNull();
    expect((await tick()).kind).toBe("ok");
  }, 20_000);
});

describe("watchdog limited service against the fake", () => {
  it("waits quietly while unregistered, restarts after 5 min, backs off, and announces service-restored", async () => {
    const pinStore = new FakePinStore({ [ICCID]: fake.state.simPin });
    let state: WatchdogState = INITIAL_WATCHDOG_STATE;
    const tick = async () => {
      const result = await runWatchdogTick({
        client,
        password: PASSWORD,
        pinStore,
        state,
        probeInternet: async () => false,
        sleep: fastSleep,
        budgetMs: 1500,
      });
      state = result.state;
      return result.event;
    };
    const posts = () => fake.state.requests.filter((r) => r.method === "POST");

    // The 2026-10-06 incident: cells seen, never registered.
    fake.state.serviceType = "LimitedService";
    fake.state.operator = "";
    fake.setConnection("Disconnected");
    await client.login(PASSWORD);
    const baseline = posts().length;

    const first = await tick();
    expect(first.kind).toBe("no-service");
    expect((await tick()).kind).toBe("no-service");
    expect(state.noServiceSince).not.toBeNull();
    expect(posts()).toHaveLength(baseline); // no connect, toggle or reboot
    expect(fake.state.connection).toBe("Disconnected");

    // 2026-10-07: five minutes in, the first restart goes out.
    state = { ...state, noServiceSince: Date.now() - 5 * 60_000 - 1000 };
    const rebooted = await tick();
    expect(rebooted.kind).toBe("rebooted");
    expect(rebooted.message).toContain("no service for 5 min");
    expect(state.noServiceRebootCount).toBe(1);
    const shutdowns = () =>
      posts().filter((r) => "general.shutdown" in r.fields);
    expect(shutdowns()).toHaveLength(1);

    // Still no coverage after the restart: the 30-minute gap holds the next
    // one back.
    await new Promise((resolve) => setTimeout(resolve, 400));
    fake.state.simStatus = "Ready";
    state = { ...state, reboot: null };
    expect((await tick()).kind).toBe("no-service");
    expect(shutdowns()).toHaveLength(1);

    // Back in coverage.
    fake.state.serviceType = "LteService";
    fake.state.operator = "Fakecom";
    fake.state.simStatus = "Ready";
    fake.setConnection("Connected");
    const restored = await tick();
    expect(restored.kind).toBe("service-restored");
    expect(restored.message).toBe("Mobile network back (Fakecom, LTE B7)");
    expect(state.noServiceSince).toBeNull();
    expect(state.noServiceRebootCount).toBe(0);
    expect(shutdowns()).toHaveLength(1);
  }, 30_000);
});
