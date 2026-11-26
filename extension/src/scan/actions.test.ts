import { describe, expect, it } from "vitest";
import {
  directArgs,
  runDirectCommand,
  runScanCommand,
  scanArgs,
  ScanCommandPorts,
} from "./actions";

function makePorts(opts: {
  prefs?: { scanInbox?: string; scannerHost?: string };
  checkOutput?: string;
}) {
  const huds: string[] = [];
  const checks: string[][] = [];
  const spawned: string[][] = [];
  const ports: ScanCommandPorts = {
    preferences: () => opts.prefs ?? { scanInbox: "/inbox" },
    runCli: async (args) => {
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

describe("runDirectCommand", () => {
  it("runs the CLI flag and shows its message as the HUD", async () => {
    const { ports, huds, checks, spawned } = makePorts({
      checkOutput: '{"ok":true,"message":"Filed: 19 pages -> a.pdf"}',
    });
    await runDirectCommand("submit", ports);
    expect(checks).toEqual([
      ["--submit", "--out-dir", "/inbox", "--no-notify"],
    ]);
    expect(huds).toEqual(["Filed: 19 pages -> a.pdf"]);
    expect(spawned).toEqual([]); // nothing is spawned: it is done in a second
  });

  it("shows a failure message too", async () => {
    const { ports, huds } = makePorts({
      checkOutput: '{"ok":false,"message":"Nothing to discard"}',
    });
    await runDirectCommand("discard", ports);
    expect(huds).toEqual(["Nothing to discard"]);
  });

  it("shows a plain failure for output it cannot read", async () => {
    const { ports, huds } = makePorts({ checkOutput: "" });
    await runDirectCommand("submit", ports);
    expect(huds).toEqual(["Scan command failed"]);
  });

  it("discards without an inbox preference, files only with one", async () => {
    const discard = makePorts({
      prefs: { scanInbox: "" },
      checkOutput: '{"ok":true,"message":"Discarded 3 pages"}',
    });
    await runDirectCommand("discard", discard.ports);
    expect(discard.checks).toEqual([["--discard", "--no-notify"]]);
    expect(discard.huds).toEqual(["Discarded 3 pages"]);

    const file = makePorts({ prefs: { scanInbox: "" } });
    await runDirectCommand("submit", file.ports);
    expect(file.huds).toEqual([
      "Set the scan inbox in the extension preferences",
    ]);
    expect(file.checks).toEqual([]);
  });
});

describe("Submit Scan after a failed Scan More", () => {
  it("the launcher command never forces and shows the refusal", async () => {
    const refusal =
      "The last Scan More failed: Scanner is busy. Scan those sheets again, or submit anyway";
    const { ports, checks, huds } = makePorts({
      checkOutput: JSON.stringify({ ok: false, message: refusal }),
    });
    await runDirectCommand("submit", ports);
    expect(checks[0]).not.toContain("--force");
    expect(huds).toEqual([refusal]);
  });

  it("only the view passes --force, and only for a submit", () => {
    const prefs = { scanInbox: "/in" };
    expect(directArgs("submit", prefs)).toEqual([
      "--submit",
      "--out-dir",
      "/in",
      "--no-notify",
    ]);
    expect(directArgs("submit", prefs, true)).toContain("--force");
    expect(directArgs("discard", prefs, true)).not.toContain("--force");
  });
});
