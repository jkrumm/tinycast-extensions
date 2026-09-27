import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { NetgearClient, parseStatus } from "./client";
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
    stdinField?: { name: string; value: string };
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
    opts?: { stdinField?: { name: string; value: string } },
  ): Promise<NetgearHttpResponse> {
    this.postCalls.push({ url, fields, stdinField: opts?.stdinField });
    return this.postResponse;
  }
}

describe("parseStatus", () => {
  it("parses the admin fixture", () => {
    const status = parseStatus(adminModel);
    expect(status).toEqual({
      userRole: "Admin",
      connection: "Connected",
      connectionText: "4G+",
      operator: "Fakecom",
      roaming: false,
      band: "LTE B7",
      radioQuality: 38,
      rxLevel: -95,
      txLevel: 12,
      dataTransferredGB: 61.44,
      battChargeLevel: 76,
      charging: true,
      batteryState: "Normal",
      simStatus: "Ready",
      simPinMode: "Enabled",
      simPinRetry: 3,
      simPukRetry: 10,
      connectedClients: 2,
    });
  });

  it("parses the guest / PIN-required fixture", () => {
    const status = parseStatus(guestModel);
    expect(status.userRole).toBe("Guest");
    expect(status.simStatus).toBe("SIM PIN required");
    expect(status.dataTransferredGB).toBe(0);
    expect(status.connectedClients).toBe(0);
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
  it("posts the token and sends the password via stdin, never argv fields", async () => {
    const transport = new FakeNetgearHttp([guestModel, adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    const status = await client.login("s3cr3t");

    expect(transport.postCalls).toHaveLength(1);
    const call = transport.postCalls[0];
    expect(call.url).toBe("http://192.168.1.1/Forms/config");
    expect(call.fields).toEqual({ token: "fake-sec-token-0002" });
    expect(call.stdinField).toEqual({
      name: "session.password",
      value: "s3cr3t",
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
    await expect(client.reboot()).rejects.toThrow(/Router rejected/);
  });

  it("reboot() sends general.shutdown=Restart with token and redirects", async () => {
    const transport = new FakeNetgearHttp([adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.reboot();
    expect(transport.postCalls[0].fields).toEqual({
      "general.shutdown": "Restart",
      token: "fake-sec-token-0001",
      ok_redirect: "/success.json",
      err_redirect: "/error.json",
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

  it("enterSimPin() sends sim.pin.entry", async () => {
    const transport = new FakeNetgearHttp([guestModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.enterSimPin("1234");
    expect(transport.postCalls[0].fields["sim.pin.entry"]).toBe("1234");
  });

  it("enterSimPuk() sends sim.puk.entry and sim.newpin", async () => {
    const transport = new FakeNetgearHttp([guestModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.enterSimPuk("87654321", "4321");
    expect(transport.postCalls[0].fields).toMatchObject({
      "sim.puk.entry": "87654321",
      "sim.newpin": "4321",
    });
  });

  it("fetches a fresh token for every action", async () => {
    const transport = new FakeNetgearHttp([adminModel, adminModel]);
    const client = new NetgearClient({ host: "http://192.168.1.1", transport });
    await client.connect();
    await client.disconnect();
    expect(transport.getCalls).toHaveLength(2);
  });
});
