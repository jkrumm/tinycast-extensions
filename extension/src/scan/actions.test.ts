import { describe, expect, it } from "vitest";
import { runScanCommand, scanArgs, ScanCommandPorts } from "./actions";

function makePorts(opts: {
  prefs?: { scanInbox?: string; scannerHost?: string };
  checkOutput?: string;
}) {
  const huds: string[] = [];
  const checks: string[][] = [];
  const spawned: string[][] = [];
  const ports: ScanCommandPorts = {
    preferences: () => opts.prefs ?? { scanInbox: "/inbox" },
    runCheck: async (args) => {
      checks.push(args);
      return opts.checkOutput ?? '{"ok":true}';
    },
    spawnScan: (args) => spawned.push(args),
    hud: async (text) => {
      huds.push(text);
    },
  };
  return { ports, huds, checks, spawned };
}

describe("scanArgs", () => {
  it("passes mode, inbox and an optional host", () => {
    expect(scanArgs("fronts", { scanInbox: " /inbox " })).toEqual([
      "--mode",
      "fronts",
      "--out-dir",
      "/inbox",
    ]);
    expect(
      scanArgs("feeder", { scanInbox: "/inbox", scannerHost: "http://h" }),
    ).toEqual([
      "--mode",
      "feeder",
      "--out-dir",
      "/inbox",
      "--host",
      "http://h",
    ]);
  });

  it("is null without an inbox", () => {
    expect(scanArgs("feeder", { scanInbox: "  " })).toBeNull();
    expect(scanArgs("feeder", {})).toBeNull();
  });
});

describe("runScanCommand", () => {
  it("checks, spawns the same arguments without --check, and says so", async () => {
    const { ports, huds, checks, spawned } = makePorts({
      prefs: { scanInbox: "/inbox", scannerHost: "http://h" },
    });
    await runScanCommand("backs", ports);
    const args = [
      "--mode",
      "backs",
      "--out-dir",
      "/inbox",
      "--host",
      "http://h",
    ];
    expect(checks).toEqual([["--check", ...args]]);
    expect(spawned).toEqual([args]);
    expect(huds).toEqual(["Scanning backs - a notification follows"]);
  });

  it("words the HUD per mode", async () => {
    const feeder = makePorts({});
    await runScanCommand("feeder", feeder.ports);
    expect(feeder.huds).toEqual(["Scanning - a notification follows"]);
    const flatbed = makePorts({});
    await runScanCommand("flatbed", flatbed.ports);
    expect(flatbed.huds).toEqual(["Scanning flatbed - a notification follows"]);
    const more = makePorts({});
    await runScanCommand("more", more.ports);
    expect(more.huds).toEqual(["Scanning more - a notification follows"]);
  });

  it("shows the reason and spawns nothing when the check fails", async () => {
    const { ports, huds, spawned } = makePorts({
      checkOutput: '{"ok":false,"message":"A scan is already running"}',
    });
    await runScanCommand("feeder", ports);
    expect(huds).toEqual(["A scan is already running"]);
    expect(spawned).toEqual([]);
  });

  it("treats unreadable check output as a failed check", async () => {
    const { ports, huds, spawned } = makePorts({ checkOutput: "" });
    await runScanCommand("feeder", ports);
    expect(huds).toEqual(["Scan check failed"]);
    expect(spawned).toEqual([]);
  });

  it("asks for the inbox preference when it is blank", async () => {
    const { ports, huds, checks } = makePorts({ prefs: { scanInbox: "" } });
    await runScanCommand("feeder", ports);
    expect(huds).toEqual(["Set the scan inbox in the extension preferences"]);
    expect(checks).toEqual([]);
  });
});
