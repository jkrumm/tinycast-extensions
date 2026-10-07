import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { NetgearClient, parseStatus } from "./client";
import { describeNetgearError } from "./errors";
import { NetgearHttp, NetgearHttpResponse, RouterModel } from "./types";

const adminModel: RouterModel = JSON.parse(
  readFileSync(join(__dirname, "fixtures/model-admin.fixture.json"), "utf8"),
);
const guestModel: RouterModel = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures/model-guest-pin-required.fixture.json"),
    "utf8",
  ),
);

class FakeNetgearHttp implements NetgearHttp {
  public getCalls: string[] = [];
  public postCalls: {
    url: string;
    fields: Record<string, string>;
    secretFields?: Record<string, string>;
  }[] = [];

  constructor(
    private modelResponses: RouterModel[],
    private postResponse: NetgearHttpResponse = {
      status: 200,
      body: '{ "success": true }',
    },
  ) {}

  async get(url: string): Promise<NetgearHttpResponse> {
    this.getCalls.push(url);
    const model =
      this.modelResponses[
        Math.min(this.getCalls.length - 1, this.modelResponses.length - 1)
      ];
    return { status: 200, body: JSON.stringify(model) };
  }

  async postForm(
    url: string,
    fields: Record<string, string>,
    opts?: { secretFields?: Record<string, string> },
  ): Promise<NetgearHttpResponse> {
    this.postCalls.push({ url, fields, secretFields: opts?.secretFields });
    return this.postResponse;
  }
}

describe("parseStatus", () => {
  it("keeps wwan.inactivityCause raw, empty when absent", () => {
    const withCause = {
      ...adminModel,
      wwan: { ...adminModel.wwan, inactivityCause: 65539 },
    };
    expect(parseStatus(withCause).inactivityCause).toBe("65539");
    expect(parseStatus(adminModel).inactivityCause).toBe("");
  });

  it("derives registration from the service type and the operator", () => {
    const model = (
      serviceType: string | undefined,
      operator: string,
      connection = "Disconnected",
    ) => ({
      ...adminModel,
      wwan: {
        ...adminModel.wwan,
        connection,
        currentNWserviceType: serviceType,
        registerNetworkDisplay: operator,
      },
    });
    const registered = parseStatus(model("LteService", "Fakecom"));
    expect(registered.serviceType).toBe("LteService");
    expect(registered.registered).toBe(true);
    // The 2026-10-06 incident: cells seen, never allowed on.
    const limited = parseStatus(model("LimitedService", ""));
    expect(limited.serviceType).toBe("LimitedService");
    expect(limited.registered).toBe(false);
    expect(parseStatus(model("NoService", "Fakecom")).registered).toBe(false);
    expect(parseStatus(model(undefined, "Fakecom")).serviceType).toBe("");
    expect(parseStatus(model(undefined, "Fakecom")).registered).toBe(false);
    // A real service type without an operator name is not registered either.
    expect(parseStatus(model("LteService", "")).registered).toBe(false);
    expect(parseStatus(guestModel).registered).toBe(false);
    // A Connected session proves registration, whatever the other fields
    // say — a firmware without `currentNWserviceType` must not silence the
    // watchdog.
    expect(parseStatus(model(undefined, "", "Connected")).registered).toBe(
      true,
    );
  });

  it("parses the admin fixture", () => {
    const status = parseStatus(adminModel);
    expect(status).toEqual({
      userRole: "Admin",
      connection: "Connected",
      inactivityCause: "",
      connectionText: "4G+",
      operator: "Fakecom",
      serviceType: "LteService",
      registered: true,
      currentlyRoaming: false,
      mcc: "001",
      mnc: "01",
      country: "Fakeland",
      band: "LTE B7",
      radioQuality: 38,
      rxLevel: -95,
      txLevel: 12,
      rsrp: -98,
      rsrq: -12,
      sinr: 4,
      rssi: -68,
      bars: 2,
      cellId: "25480193",
      caSecondaryCells: 1,
      dataTransferredGB: 61.44,
      battChargeLevel: 76,
      charging: true,
      batteryState: "Normal",
      simStatus: "Ready",
      simPinMode: "Enabled",
      simPinRetry: 3,
      simPukRetry: 10,
      connectedClients: 2,
      connectedDevices: [
        {
          ip: "192.168.1.10",
          mac: "AA:BB:CC:00:00:01",
          name: "fake-laptop",
          media: "WiFi",
        },
        {
          ip: "192.168.1.11",
          mac: "AA:BB:CC:00:00:02",
          name: "fake-phone",
          media: "WiFi",
        },
      ],
      uptimeSeconds: 90811,
      batteryTemperature: 43,
      smsReady: true,
      smsUnread: 2,
      iccid: "8900000000000000001",
      simOperator: "Fakecom",
      activeProfileId: "1",
      profiles: [
        {
          id: "1",
          index: 0,
          name: "Internet",
          apn: "internet.fake",
          username: "",
          authtype: "None",
          type: "IPV4V6",
          pdpRoamingType: "IPV4V6",
          hasPassword: false,
          editable: true,
          deletable: false, // the active profile can never be deleted
        },
        {
          id: "Locked Carrier 1",
          index: 1,
          name: "Locked Carrier",
          apn: "carrier.locked.fake",
          username: "carrier",
          authtype: "PAPCHAP",
          type: "IPV4V6",
          pdpRoamingType: "IPV4V6",
          hasPassword: true,
          editable: false, // access_control 2 = write-deny
          deletable: true,
        },
        {
          id: "No Roaming 2",
          index: 2,
          name: "No Roaming",
          apn: "noroam.fake",
          username: "",
          authtype: "None",
          type: "IPV4",
          pdpRoamingType: "None",
          hasPassword: false,
          editable: true,
          deletable: true,
        },
      ],
      autoconnect: "Always",
      roamingAllowed: true,
      smsMessages: [
        {
          id: "1",
          rxTime: "2026-09-20T10:00:00Z",
          text: "Your balance is low.",
          sender: "+10000000000",
          read: false,
        },
        {
          id: "2",
          rxTime: "2026-09-19T08:00:00Z",
          text: "Welcome to Fakecom.",
          sender: "1000",
          read: true,
        },
      ],
    });
  });

  it("parses the guest / PIN-required fixture", () => {
    const status = parseStatus(guestModel);
    expect(status.userRole).toBe("Guest");
    expect(status.simStatus).toBe("Locked");
    expect(status.dataTransferredGB).toBe(0);
    expect(status.connectedClients).toBe(0);
  });

  it("defaults the new optional fields when absent from the model", () => {
    const status = parseStatus(guestModel);
    expect(status.connectedDevices).toEqual([]);
    expect(status.uptimeSeconds).toBeNull();
    expect(status.batteryTemperature).toBeNull();
    expect(status.smsReady).toBe(false);
    expect(status.smsUnread).toBe(0);
    expect(status.iccid).toBe("");
    expect(status.simOperator).toBe("");
    expect(status.activeProfileId).toBe("");
    expect(status.profiles).toEqual([]);
    expect(status.autoconnect).toBe("");
    expect(status.roamingAllowed).toBe(false);
    expect(status.smsMessages).toEqual([]);
    expect(status.currentlyRoaming).toBe(false);
    expect(status.mcc).toBe("");
    expect(status.mnc).toBe("");
    expect(status.country).toBe("");
  });

  it("leaves the radio detail null when the router reports none", () => {
    const status = parseStatus(guestModel);
    expect(status.rsrp).toBeNull();
    expect(status.rsrq).toBeNull();
    expect(status.sinr).toBeNull();
    expect(status.rssi).toBeNull();
    expect(status.bars).toBeNull();
    expect(status.cellId).toBeNull();
    expect(status.caSecondaryCells).toBeNull();
  });

  it("reads radio detail given as numeric strings and drops unreadable values", () => {
    const model: RouterModel = JSON.parse(JSON.stringify(adminModel));
    Object.assign(model.wwan.signalStrength ?? {}, {
      sinr: "-1",
      rsrp: "",
      rsrq: "n/a",
    });
    model.wwanadv.cellId = "0x1234";
    const status = parseStatus(model);
    expect(status.sinr).toBe(-1);
    expect(status.rsrp).toBeNull();
    expect(status.rsrq).toBeNull();
    expect(status.cellId).toBe("0x1234");
  });

  it("never exposes a profile password, only hasPassword", () => {
    const model: RouterModel = JSON.parse(JSON.stringify(adminModel));
    model.wwan.profileList = [
      { id: "p", name: "n", apn: "a", password: "hunter2" },
    ];
    const status = parseStatus(model);
    expect(status.profiles[0].hasPassword).toBe(true);
    expect(JSON.stringify(status)).not.toContain("hunter2");
  });

  it("reads wwan.roaming as currentlyRoaming", () => {
    const model: RouterModel = JSON.parse(JSON.stringify(adminModel));
    model.wwan.roaming = true;
    expect(parseStatus(model).currentlyRoaming).toBe(true);
  });

  it("falls back to APN / roamingtype and decodes access_control", () => {
    const model: RouterModel = JSON.parse(JSON.stringify(adminModel));
    model.wwan.profile = { default: "active" };
    model.wwan.profileList = [
      { id: "active", index: 0, APN: "caps.fake", roamingtype: "IPV4" },
      { id: "wd", index: 1, access_control: 2 },
      { id: "dd", index: 2, access_control: 4 },
      { id: "both", index: 3, access_control: 6 },
      { id: "str", index: 4, access_control: "6" },
      { id: "none", index: 5, access_control: "" },
      {},
    ];
    const byId = Object.fromEntries(
      parseStatus(model).profiles.map((p) => [p.id, p]),
    );
    expect(byId.active).toMatchObject({
      apn: "caps.fake",
      pdpRoamingType: "IPV4",
      editable: true,
      deletable: false,
    });
    expect(byId.wd).toMatchObject({ editable: false, deletable: true });
    expect(byId.dd).toMatchObject({ editable: true, deletable: false });
    expect(byId.both).toMatchObject({ editable: false, deletable: false });
    expect(byId.str).toMatchObject({ editable: false, deletable: false });
    expect(byId.none).toMatchObject({ editable: true, deletable: true });
  });

  it("defaults connectedClients to null when router.clientList is absent", () => {
    const withoutRouter: RouterModel = { ...adminModel, router: undefined };
    const status = parseStatus(withoutRouter);
    expect(status.connectedClients).toBeNull();
  });
});

describe("NetgearClient.getStatus", () => {
  it("fetches model.json and parses it", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const status = await client.getStatus();
    expect(status.userRole).toBe("Admin");
    expect(transport.getCalls).toEqual(["http://192.168.1.1/api/model.json"]);
  });

  it("strips a trailing slash from host", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({
      host: "http://192.168.1.1/",
      transport,
    });
    await client.getStatus();
    expect(transport.getCalls[0]).toBe("http://192.168.1.1/api/model.json");
  });
});

describe("NetgearClient.login", () => {
  it("posts the token and sends the password via secretFields, never argv fields", async () => {
    const transport = new FakeNetgearHttp([guestModel, adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const status = await client.login("s3cr3t");

    expect(transport.postCalls).toHaveLength(1);
    const call = transport.postCalls[0];
    expect(call.url).toBe("http://192.168.1.1/Forms/config");
    expect(call.fields).toEqual({ token: "fake-sec-token-0002" });
    expect(call.secretFields).toEqual({
      "session.password": "s3cr3t",
    });
    expect(status.userRole).toBe("Admin");
  });
});

describe("NetgearClient actions", () => {
  it("throws when the router redirects to /error.json", async () => {
    const transport = new FakeNetgearHttp([adminModel], {
      status: 200,
      body: '\n{\n\t"errno": ,\n\t"errdetail": ""\n}\n',
    });
    const client = new NetgearClient({ host: "http://router", transport });
    await expect(client.reboot()).rejects.toThrow(
      /^Router rejected the reboot request/,
    );
  });

  describe("reboot()", () => {
    const OK = { status: 200, body: '{ "success": true }' };
    const REFUSED = {
      status: 200,
      body: '{ "errno": 1, "errdetail": "general.shutdown" }\n',
    };

    // Answers each POST from `responses` in order (sticky at the last one).
    class SequencedPosts extends FakeNetgearHttp {
      constructor(private readonly responses: NetgearHttpResponse[]) {
        super([adminModel]);
      }
      async postForm(
        url: string,
        fields: Record<string, string>,
      ): Promise<NetgearHttpResponse> {
        const n = this.postCalls.length;
        await super.postForm(url, fields);
        return this.responses[Math.min(n, this.responses.length - 1)];
      }
    }

    const shutdownValues = (transport: FakeNetgearHttp) =>
      transport.postCalls.map((c) => c.fields["general.shutdown"]);

    it("sends general.shutdown=restart with token and redirects", async () => {
      const transport = new SequencedPosts([OK]);
      const client = new NetgearClient({
        host: "http://192.168.1.1",
        transport,
      });
      await client.reboot();
      expect(transport.postCalls).toHaveLength(1);
      expect(transport.postCalls[0].fields).toEqual({
        "general.shutdown": "restart",
        token: "fake-sec-token-0001",
        ok_redirect: "/success.json",
        err_redirect: "/error.json",
      });
    });

    it("retries once with Restart when restart is refused", async () => {
      const transport = new SequencedPosts([REFUSED, OK]);
      const client = new NetgearClient({ host: "http://router", transport });
      await client.reboot();
      expect(shutdownValues(transport)).toEqual(["restart", "Restart"]);
    });

    it("throws a both-variants error when both spellings are refused", async () => {
      const transport = new SequencedPosts([REFUSED]);
      const client = new NetgearClient({ host: "http://router", transport });
      const error = await client.reboot().then(
        () => null,
        (e: Error) => e,
      );
      expect(shutdownValues(transport)).toEqual(["restart", "Restart"]);
      expect(error?.message).toMatch(
        /^Router rejected the reboot request \(tried both variants, "restart" and "Restart"\): .*"errdetail": "general\.shutdown"/,
      );
      expect(describeNetgearError(error)).toBe(
        "Router refused the restart (tried both variants) — restart it from the router's website or power button.",
      );
    });

    it("does not retry when the router is unreachable", async () => {
      const transport = new SequencedPosts([OK]);
      transport.postForm = async (url, fields) => {
        transport.postCalls.push({ url, fields });
        throw new Error("curl exited 7: couldn't connect");
      };
      const client = new NetgearClient({ host: "http://router", transport });
      await expect(client.reboot()).rejects.toThrow(/curl exited 7/);
      expect(transport.postCalls).toHaveLength(1);
    });
  });

  it("connect() sends wwan.connect=DefaultProfile", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.connect();
    expect(transport.postCalls[0].fields["wwan.connect"]).toBe(
      "DefaultProfile",
    );
  });

  it("disconnect() sends wwan.connect=0", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.disconnect();
    expect(transport.postCalls[0].fields["wwan.connect"]).toBe("0");
  });

  it("enterSimPin() posts to /Forms/config with sim.pin.entry as a secretField", async () => {
    const transport = new FakeNetgearHttp([guestModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.enterSimPin("1234");
    const call = transport.postCalls[0];
    expect(call.url).toBe("http://192.168.1.1/Forms/config");
    expect(call.fields["sim.pin.entry"]).toBeUndefined();
    expect(call.secretFields).toEqual({ "sim.pin.entry": "1234" });
  });

  it("enterSimPuk() posts to /Forms/pinChange with puk/newpin as secretFields", async () => {
    const transport = new FakeNetgearHttp([guestModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.enterSimPuk("87654321", "4321");
    const call = transport.postCalls[0];
    expect(call.url).toBe("http://192.168.1.1/Forms/pinChange");
    expect(call.fields).toEqual({
      token: "fake-sec-token-0002",
      ok_redirect: "/success.json",
      err_redirect: "/error.json",
    });
    expect(call.secretFields).toEqual({
      "sim.puk.entry": "87654321",
      "sim.newpin": "4321",
    });
  });

  it("changeSimPin() posts to /Forms/pinChange with old/new PIN as secretFields", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.changeSimPin("1111", "2222");
    const call = transport.postCalls[0];
    expect(call.url).toBe("http://192.168.1.1/Forms/pinChange");
    expect(call.secretFields).toEqual({
      "sim.pin.change": "1111",
      "sim.newpin": "2222",
    });
  });

  it("setSimPinLock() enables via sim.pin.enable as a secretField", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.setSimPinLock({ enabled: true, pin: "1234" });
    const call = transport.postCalls[0];
    expect(call.url).toBe("http://192.168.1.1/Forms/config");
    expect(call.secretFields).toEqual({ "sim.pin.enable": "1234" });
  });

  it("setSimPinLock() disables via sim.pin.disable as a secretField", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.setSimPinLock({ enabled: false, pin: "1234" });
    const call = transport.postCalls[0];
    expect(call.secretFields).toEqual({ "sim.pin.disable": "1234" });
  });

  it("setActiveProfile() sends wwan.profile.default and disables the APN prompt", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.setActiveProfile("2");
    expect(transport.postCalls[0].fields).toMatchObject({
      "wwan.profile.default": "2",
      "wwan.profile.promptForApnSelection": "false",
    });
  });

  it("createProfile() posts to /Forms/profile with the password as a secretField", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.createProfile({
      name: "Work",
      apn: "work.fake",
      username: "user",
      password: "s3cr3t",
      authtype: "PAP",
      type: "IPV4V6",
      pdproamingtype: "IPV4V6",
    });
    const call = transport.postCalls[0];
    expect(call.url).toBe("http://192.168.1.1/Forms/profile");
    expect(call.fields).toMatchObject({
      action: "create",
      "profile.name": "Work",
      "profile.apn": "work.fake",
      "profile.username": "user",
      "profile.authtype": "PAP",
      "profile.type": "IPV4V6",
      "profile.pdproamingtype": "IPV4V6",
      "profile.ipaddr": "0.0.0.0",
    });
    expect(call.fields["profile.password"]).toBeUndefined();
    expect(call.secretFields).toEqual({ "profile.password": "s3cr3t" });
  });

  it("createProfile() sends an empty profile.password field when none is given", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.createProfile({
      name: "Work",
      apn: "work.fake",
      authtype: "None",
      type: "IPV4",
      pdproamingtype: "IPV4",
    });
    const call = transport.postCalls[0];
    expect(call.fields["profile.password"]).toBe("");
    expect(call.secretFields).toBeUndefined();
  });

  it("updateProfile() sends the exact update field set, no ipaddr, password as a secretField", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.updateProfile({
      id: "Work 1",
      name: "Work",
      apn: "work.fake",
      username: "user",
      password: "n3w",
      authtype: "PAP",
      type: "IPV4V6",
      pdproamingtype: "IPV4",
    });
    const call = transport.postCalls[0];
    expect(call.url).toBe("http://192.168.1.1/Forms/profile");
    expect(call.fields).toEqual({
      action: "update",
      "profile.id": "Work 1",
      "profile.name": "Work",
      "profile.apn": "work.fake",
      "profile.username": "user",
      "profile.type": "IPV4V6",
      "profile.pdproamingtype": "IPV4",
      "profile.authtype": "PAP",
      token: "fake-sec-token-0001",
      ok_redirect: "/success.json",
      err_redirect: "/error.json",
    });
    expect(call.secretFields).toEqual({ "profile.password": "n3w" });
  });

  it("updateProfile() omits profile.password entirely when unchanged", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.updateProfile({
      id: "Work 1",
      name: "Work",
      apn: "work.fake",
      authtype: "None",
      type: "IPV4",
      pdproamingtype: "IPV4",
    });
    const call = transport.postCalls[0];
    expect(call.fields).not.toHaveProperty("profile.password");
    expect(call.fields).not.toHaveProperty("profile.ipaddr");
    expect(call.fields["profile.username"]).toBe("");
    expect(call.secretFields).toBeUndefined();
  });

  it("deleteProfile() posts action=delete with profile.id to /Forms/profile", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.deleteProfile("Work 1");
    const call = transport.postCalls[0];
    expect(call.url).toBe("http://192.168.1.1/Forms/profile");
    expect(call.fields).toEqual({
      action: "delete",
      "profile.id": "Work 1",
      token: "fake-sec-token-0001",
      ok_redirect: "/success.json",
      err_redirect: "/error.json",
    });
    expect(call.secretFields).toBeUndefined();
  });

  it("setRoaming(true) sends wwan.autoconnect=Always", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.setRoaming(true);
    expect(transport.postCalls[0].fields["wwan.autoconnect"]).toBe("Always");
  });

  it("setRoaming(false) sends wwan.autoconnect=HomeNetwork", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.setRoaming(false);
    expect(transport.postCalls[0].fields["wwan.autoconnect"]).toBe(
      "HomeNetwork",
    );
  });

  it("setDataEnabled(false) sends wwan.autoconnect=Never", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.setDataEnabled(false);
    expect(transport.postCalls[0].fields["wwan.autoconnect"]).toBe("Never");
  });

  it("setDataEnabled(true) sends wwan.autoconnect=Always", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.setDataEnabled(true);
    expect(transport.postCalls[0].fields["wwan.autoconnect"]).toBe("Always");
  });

  it("setDataEnabled names the data request when the router refuses it", async () => {
    const transport = new FakeNetgearHttp([adminModel], {
      status: 200,
      body: '{ "errno": , "errdetail": "" }',
    });
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await expect(client.setDataEnabled(false)).rejects.toThrow(
      /^Router rejected the data request/,
    );
  });

  it("markSmsRead() sends sms.readId", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.markSmsRead("1");
    expect(transport.postCalls[0].fields["sms.readId"]).toBe("1");
  });

  it("deleteSms() sends sms.deleteId", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.deleteSms("1");
    expect(transport.postCalls[0].fields["sms.deleteId"]).toBe("1");
  });

  it("fetches a fresh token for every action", async () => {
    const transport = new FakeNetgearHttp([adminModel, adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.connect();
    await client.disconnect();
    expect(transport.getCalls).toHaveLength(2);
  });
});
