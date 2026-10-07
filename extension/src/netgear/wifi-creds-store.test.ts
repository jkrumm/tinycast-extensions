import { describe, it, expect } from "vitest";
import {
  KeychainWifiCredsStore,
  captureWifiCredentials,
  WifiCredsStore,
} from "./wifi-creds-store";
import { SecretRunner } from "../lib/secrets";
import { WifiCredentials } from "./wifi";

class FakeRunner implements SecretRunner {
  calls: { bin: string; args: string[] }[] = [];
  constructor(
    private readonly responses: Record<string, string | Error> = {},
  ) {}

  async exec(bin: string, args: string[]): Promise<string> {
    this.calls.push({ bin, args });
    const key = args.join(" ");
    const response = this.responses[key];
    if (response instanceof Error) throw response;
    return response ?? "";
  }
}

const CREDS: WifiCredentials = { ssid: "FakeNet", passphrase: "s3cr3t" };

describe("KeychainWifiCredsStore.get", () => {
  it("returns null when Keychain has no entry", async () => {
    const runner = new FakeRunner({
      "find-generic-password -s tinycast-extensions -a netgear-wifi -w":
        new Error("not found"),
    });
    const store = new KeychainWifiCredsStore(runner);
    expect(await store.get()).toBeNull();
  });

  it("parses the stored JSON", async () => {
    const runner = new FakeRunner({
      "find-generic-password -s tinycast-extensions -a netgear-wifi -w":
        JSON.stringify(CREDS) + "\n",
    });
    const store = new KeychainWifiCredsStore(runner);
    expect(await store.get()).toEqual(CREDS);
  });

  it("returns null for malformed JSON instead of throwing", async () => {
    const runner = new FakeRunner({
      "find-generic-password -s tinycast-extensions -a netgear-wifi -w":
        "not json",
    });
    const store = new KeychainWifiCredsStore(runner);
    expect(await store.get()).toBeNull();
  });

  it("returns null when the stored value is missing a field", async () => {
    const runner = new FakeRunner({
      "find-generic-password -s tinycast-extensions -a netgear-wifi -w":
        JSON.stringify({ ssid: "FakeNet" }),
    });
    const store = new KeychainWifiCredsStore(runner);
    expect(await store.get()).toBeNull();
  });
});

describe("KeychainWifiCredsStore.set", () => {
  it("writes the credentials as JSON under the fixed netgear-wifi account", async () => {
    const runner = new FakeRunner();
    const store = new KeychainWifiCredsStore(runner);
    await store.set(CREDS);
    expect(runner.calls).toEqual([
      {
        bin: "/usr/bin/security",
        args: [
          "add-generic-password",
          "-U",
          "-s",
          "tinycast-extensions",
          "-a",
          "netgear-wifi",
          "-w",
          JSON.stringify(CREDS),
        ],
      },
    ]);
  });
});

class FakeWifiCredsStore implements WifiCredsStore {
  public setCalls: WifiCredentials[] = [];
  constructor(private stored: WifiCredentials | null = null) {}
  async get(): Promise<WifiCredentials | null> {
    return this.stored;
  }
  async set(creds: WifiCredentials): Promise<void> {
    this.stored = creds;
    this.setCalls.push(creds);
  }
}

describe("captureWifiCredentials", () => {
  it("stores the credentials the client reports", async () => {
    const store = new FakeWifiCredsStore();
    await captureWifiCredentials({
      client: { getWifiCredentials: async () => CREDS },
      store,
    });
    expect(store.setCalls).toEqual([CREDS]);
  });

  it("is a no-op when the client has no credentials (Guest role)", async () => {
    const store = new FakeWifiCredsStore();
    await captureWifiCredentials({
      client: { getWifiCredentials: async () => null },
      store,
    });
    expect(store.setCalls).toHaveLength(0);
  });

  it("swallows a failure from the client without throwing", async () => {
    const store = new FakeWifiCredsStore();
    await expect(
      captureWifiCredentials({
        client: {
          getWifiCredentials: async () => {
            throw new Error("curl exited 7");
          },
        },
        store,
      }),
    ).resolves.toBeUndefined();
    expect(store.setCalls).toHaveLength(0);
  });
});
