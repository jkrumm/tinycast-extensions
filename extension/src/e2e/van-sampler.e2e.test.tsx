import { describe, it, expect, vi, beforeEach } from "vitest";
import { LocalStorage, environment } from "@raycast/api";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { __commandMetadataUpdates } from "./raycast-fake";
import { parseCaptureLog } from "../van/capture-log";
import {
  HELPER_BATTERY_BUSY,
  HELPER_BLUETOOTH_OFF,
  HELPER_FULL,
  helperAtSoc,
} from "../van/fixtures";
import { HelperResult } from "../van/types";
import { setSamplerPaused } from "../van/sampler-storage";

const readMock =
  vi.fn<
    (opts?: {
      unattended?: boolean;
    }) => Promise<{ helper: HelperResult; keyMissing: boolean }>
  >();
vi.mock("../van/run", () => ({
  readVan: (opts?: { unattended?: boolean }) => readMock(opts),
  runVictronAll: () => {
    throw new Error("the sampler never opens the Victron GATT session");
  },
}));
const notifyMock =
  vi.fn<(opts: { title: string; body: string }) => Promise<boolean>>();
vi.mock("../van/notify", () => ({
  postNotification: (opts: { title: string; body: string }) => notifyMock(opts),
}));

import VanSampler from "../van-sampler";

const logPath = join(environment.supportPath, "van-log.jsonl");
const storedSamples = async () =>
  JSON.parse((await LocalStorage.getItem<string>("van-history")) ?? "[]");
const lastSubtitle = () => __commandMetadataUpdates.at(-1)?.subtitle;

describe("van sampler command", () => {
  beforeEach(async () => {
    readMock.mockReset();
    notifyMock.mockReset();
    notifyMock.mockResolvedValue(true);
    __commandMetadataUpdates.length = 0;
    await LocalStorage.clear();
    rmSync(logPath, { force: true });
  });

  it("takes the live read unattended and persists it like an open: a sample and a capture line marked background", async () => {
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    await VanSampler();
    expect(readMock).toHaveBeenCalledWith({ unattended: true });
    expect(await storedSamples()).toHaveLength(1);
    const [entry] = parseCaptureLog(readFileSync(logPath, "utf8"));
    expect(entry).toMatchObject({
      source: "background",
      ective: { soc: 98 },
      estimateReason: "background",
    });
    expect(lastSubtitle()).toMatch(/^98 % · \d\d:\d\d$/);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("nothing in range: no sample, no log line, a quiet subtitle", async () => {
    readMock.mockResolvedValue({
      helper: {
        battery: null,
        victron: null,
        errors: ["battery-not-found", "victron-not-found"],
      },
      keyMissing: false,
    });
    await VanSampler();
    expect(await storedSamples()).toEqual([]);
    expect(await LocalStorage.getItem("van-history")).toBeUndefined();
    expect(() => readFileSync(logPath, "utf8")).toThrow();
    expect(lastSubtitle()).toBe("Van not in range");
  });

  it("the phone app holding the BMS is named; the charger's reading is still kept", async () => {
    readMock.mockResolvedValue({
      helper: HELPER_BATTERY_BUSY,
      keyMissing: false,
    });
    await VanSampler();
    expect(lastSubtitle()).toBe("Phone app holds the battery");
    expect(await storedSamples()).toHaveLength(1);
  });

  it("Bluetooth off and a crashing helper are outcomes, not failures", async () => {
    readMock.mockResolvedValue({
      helper: HELPER_BLUETOOTH_OFF,
      keyMissing: false,
    });
    await VanSampler();
    expect(lastSubtitle()).toBe("Bluetooth off");
    readMock.mockRejectedValue(new Error("van-ble exited 1"));
    await expect(VanSampler()).resolves.toBeUndefined();
    expect(lastSubtitle()).toBe("Read failed");
    expect(await storedSamples()).toEqual([]);
  });

  it("paused: returns at once without a read", async () => {
    await setSamplerPaused(true);
    await VanSampler();
    expect(readMock).not.toHaveBeenCalled();
    expect(lastSubtitle()).toBe("Paused");
    await setSamplerPaused(false);
    readMock.mockResolvedValue({ helper: HELPER_FULL, keyMissing: false });
    await VanSampler();
    expect(readMock).toHaveBeenCalledTimes(1);
  });

  it("posts one notification when the charge crosses down through 30 %, none while it stays low, and re-arms after a recovery", async () => {
    const run = async (soc: number) => {
      readMock.mockResolvedValue({
        helper: helperAtSoc(soc),
        keyMissing: false,
      });
      await VanSampler();
    };
    await run(41);
    expect(notifyMock).not.toHaveBeenCalled();
    await run(28);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      title: "Van battery",
      body: "Van battery 28 % — stop charging devices from the van",
    });
    await run(27);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    await run(14);
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock.mock.calls[1][0].body).toContain("critically low");
    await run(40); // back above both thresholds + margin
    await run(29);
    expect(notifyMock).toHaveBeenCalledTimes(3);
  });

  it("a notification that cannot be shown never fails the run", async () => {
    notifyMock.mockResolvedValue(false);
    readMock.mockResolvedValue({ helper: helperAtSoc(20), keyMissing: false });
    await expect(VanSampler()).resolves.toBeUndefined();
    expect(lastSubtitle()).toMatch(/^20 % /);
  });
});
