import { describe, expect, it } from "vitest";
import { keepAwake } from "./keep-awake";

describe("keepAwake", () => {
  it("starts caffeinate tied to the scan process", () => {
    const calls: { bin: string; args: string[] }[] = [];
    let unref = 0;
    const ok = keepAwake({
      pid: 4242,
      log: () => undefined,
      spawn: (bin, args) => {
        calls.push({ bin, args });
        return { unref: () => void unref++, on: () => undefined };
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      { bin: "/usr/bin/caffeinate", args: ["-i", "-w", "4242"] },
    ]);
    expect(unref).toBe(1);
  });

  it("logs and carries on when it cannot start", () => {
    const logs: string[] = [];
    const ok = keepAwake({
      pid: 1,
      log: (line) => logs.push(line),
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(ok).toBe(false);
    expect(logs).toEqual(["caffeinate failed: ENOENT"]);
  });

  it("logs an asynchronous spawn error", () => {
    const logs: string[] = [];
    keepAwake({
      pid: 1,
      log: (line) => logs.push(line),
      spawn: () => ({
        unref: () => undefined,
        on: (_event, listener) => listener(new Error("EPERM")),
      }),
    });
    expect(logs).toEqual(["caffeinate failed: EPERM"]);
  });
});
