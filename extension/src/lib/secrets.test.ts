import { describe, it, expect } from "vitest";
import {
  getSecret,
  resolveSecret,
  SecretUnavailableError,
  SecretRunner,
} from "./secrets";

class FakeRunner implements SecretRunner {
  public calls: { bin: string; args: string[] }[] = [];

  constructor(private responses: Record<string, string | Error> = {}) {}

  async exec(bin: string, args: string[]): Promise<string> {
    this.calls.push({ bin, args });
    const key = `${bin} ${args[0]}`;
    const response = this.responses[key];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`no fake response for ${key}`);
    return response;
  }
}

const REF = "op://common/api/SECRET";

describe("resolveSecret", () => {
  it("returns the override without touching Keychain or 1Password", async () => {
    const runner = new FakeRunner();
    const value = await resolveSecret({
      key: "apiToken",
      ref: REF,
      override: "  overridden  ",
      runner,
    });
    expect(value).toBe("  overridden  ");
    expect(runner.calls).toHaveLength(0);
  });

  it("ignores a blank override and falls through to Keychain", async () => {
    const runner = new FakeRunner({
      "/usr/bin/security find-generic-password": "from-keychain\n",
    });
    const value = await resolveSecret({
      key: "apiToken",
      ref: REF,
      override: "   ",
      runner,
    });
    expect(value).toBe("from-keychain");
  });

  it("falls back to Keychain when no override is set", async () => {
    const runner = new FakeRunner({
      "/usr/bin/security find-generic-password": "cached-token\n",
    });
    const value = await resolveSecret({ key: "apiToken", ref: REF, runner });
    expect(value).toBe("cached-token");
    expect(runner.calls).toHaveLength(1);
  });

  it("falls back to 1Password when Keychain is empty, then caches it", async () => {
    const runner = new FakeRunner({
      "/usr/bin/security find-generic-password": new Error("not found"),
      "/opt/homebrew/bin/op read": "from-1password\n",
      "/usr/bin/security add-generic-password": "",
    });
    const value = await resolveSecret({ key: "apiToken", ref: REF, runner });
    expect(value).toBe("from-1password");

    const writeCall = runner.calls.find((c) =>
      c.args.includes("add-generic-password"),
    );
    expect(writeCall?.args).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "tinycast-extensions",
      "-a",
      "apiToken",
      "-w",
      "from-1password",
    ]);
  });

  it("passes --account tkrumm to op read", async () => {
    const runner = new FakeRunner({
      "/usr/bin/security find-generic-password": new Error("not found"),
      "/opt/homebrew/bin/op read": "value\n",
      "/usr/bin/security add-generic-password": "",
    });
    await resolveSecret({ key: "netgearPassword", ref: REF, runner });
    const opCall = runner.calls.find((c) => c.bin === "/opt/homebrew/bin/op");
    expect(opCall?.args).toEqual(["read", REF, "--account", "tkrumm"]);
  });

  it("throws SecretUnavailableError when all three fail", async () => {
    const runner = new FakeRunner({
      "/usr/bin/security find-generic-password": new Error("not found"),
      "/opt/homebrew/bin/op read": new Error("not signed in"),
    });
    await expect(
      resolveSecret({ key: "netgearPassword", ref: REF, runner }),
    ).rejects.toThrow(SecretUnavailableError);
    await expect(
      resolveSecret({ key: "netgearPassword", ref: REF, runner }),
    ).rejects.toThrow(/make secrets/);
  });

  it("still resolves even when the Keychain cache write fails", async () => {
    const runner = new FakeRunner({
      "/usr/bin/security find-generic-password": new Error("not found"),
      "/opt/homebrew/bin/op read": "from-1password\n",
      "/usr/bin/security add-generic-password": new Error("disk full"),
    });
    const value = await resolveSecret({ key: "apiToken", ref: REF, runner });
    expect(value).toBe("from-1password");
  });
});

describe("getSecret", () => {
  it("picks the apiToken override and ref from preferences", async () => {
    const runner = new FakeRunner();
    const value = await getSecret(
      "apiToken",
      {
        apiToken: "tok",
        apiTokenRef: REF,
        netgearPasswordRef: "op://Private/x",
        victronKeyRef: "op://Private/v",
      },
      runner,
    );
    expect(value).toBe("tok");
  });

  it("picks the netgearPassword override and ref from preferences", async () => {
    const runner = new FakeRunner({
      "/usr/bin/security find-generic-password": "router-pw\n",
    });
    const value = await getSecret(
      "netgearPassword",
      {
        apiTokenRef: REF,
        netgearPassword: undefined,
        netgearPasswordRef: "op://Private/Netgear M2 Jo/Admin Passwort",
        victronKeyRef: "op://Private/v",
      },
      runner,
    );
    expect(value).toBe("router-pw");
  });

  it("resolves victronKey through its own override, Keychain account and ref", async () => {
    const prefs = {
      apiTokenRef: REF,
      netgearPasswordRef: "op://Private/x",
      victronKeyRef: "op://Private/Solar Camper Victron/Instant Readout Key",
    };
    expect(await getSecret("victronKey", { ...prefs, victronKey: "k" })).toBe(
      "k",
    );

    const runner = new FakeRunner({
      "/usr/bin/security find-generic-password": new Error("not found"),
      "/opt/homebrew/bin/op read": "from-op\n",
      "/usr/bin/security add-generic-password": "",
    });
    expect(await getSecret("victronKey", prefs, runner)).toBe("from-op");
    expect(runner.calls[0].args).toContain("victronKey");
    expect(runner.calls[1].args).toContain(prefs.victronKeyRef);
  });
});
