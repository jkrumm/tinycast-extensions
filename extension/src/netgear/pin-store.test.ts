import { describe, it, expect } from "vitest";
import { KeychainSimPinStore } from "./pin-store";
import { SecretRunner } from "../lib/secrets";

const ICCID = "8900000000000000001";

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

describe("KeychainSimPinStore.get", () => {
  it("returns null for an empty iccid without calling security", async () => {
    const runner = new FakeRunner();
    const store = new KeychainSimPinStore(runner);
    expect(await store.get("")).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it("reads the pin from the netgear-sim-pin:<iccid> account", async () => {
    const runner = new FakeRunner({
      [`find-generic-password -s tinycast-extensions -a netgear-sim-pin:${ICCID} -w`]:
        "1234\n",
    });
    const store = new KeychainSimPinStore(runner);
    expect(await store.get(ICCID)).toBe("1234");
  });

  it("returns null when Keychain has no entry", async () => {
    const runner = new FakeRunner({
      [`find-generic-password -s tinycast-extensions -a netgear-sim-pin:${ICCID} -w`]:
        new Error("not found"),
    });
    const store = new KeychainSimPinStore(runner);
    expect(await store.get(ICCID)).toBeNull();
  });
});

describe("KeychainSimPinStore.set", () => {
  it("writes the pin under the per-iccid account, updating in place", async () => {
    const runner = new FakeRunner();
    const store = new KeychainSimPinStore(runner);
    await store.set(ICCID, "5678");
    expect(runner.calls).toEqual([
      {
        bin: "/usr/bin/security",
        args: [
          "add-generic-password",
          "-U",
          "-s",
          "tinycast-extensions",
          "-a",
          `netgear-sim-pin:${ICCID}`,
          "-w",
          "5678",
        ],
      },
    ]);
  });

  it("is a no-op for an empty iccid", async () => {
    const runner = new FakeRunner();
    const store = new KeychainSimPinStore(runner);
    await store.set("", "5678");
    expect(runner.calls).toHaveLength(0);
  });
});

describe("KeychainSimPinStore.delete", () => {
  it("deletes the per-iccid entry", async () => {
    const runner = new FakeRunner();
    const store = new KeychainSimPinStore(runner);
    await store.delete(ICCID);
    expect(runner.calls).toEqual([
      {
        bin: "/usr/bin/security",
        args: [
          "delete-generic-password",
          "-s",
          "tinycast-extensions",
          "-a",
          `netgear-sim-pin:${ICCID}`,
        ],
      },
    ]);
  });

  it("swallows a missing-entry error", async () => {
    const runner = new FakeRunner({
      [`delete-generic-password -s tinycast-extensions -a netgear-sim-pin:${ICCID}`]:
        new Error("not found"),
    });
    const store = new KeychainSimPinStore(runner);
    await expect(store.delete(ICCID)).resolves.toBeUndefined();
  });

  it("is a no-op for an empty iccid", async () => {
    const runner = new FakeRunner();
    const store = new KeychainSimPinStore(runner);
    await store.delete("");
    expect(runner.calls).toHaveLength(0);
  });
});
