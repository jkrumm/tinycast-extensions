import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { Action, Detail } from "@raycast/api";
import {
  renderCommand,
  waitFor,
  assertNoBadSubstrings,
  imageSvg,
} from "./render";
import { BatterySnapshot } from "../battery/types";

const collectMock = vi.fn<() => Promise<BatterySnapshot>>();
vi.mock("../battery/collect", () => ({
  collectBatterySnapshot: () => collectMock(),
}));

import Battery from "../battery";

const snapshot: BatterySnapshot = {
  status: {
    charging: { allowCharging: true, useAdapter: true, pluggedIn: true },
    battery: {
      currentChargePercent: 76,
      state: "charging",
      timeToLimitMinutes: 42,
      fullCapacityMah: 8694,
      chargeRateWatts: 12.3,
      voltageVolts: 12.23,
    },
    configuration: {
      enabled: true,
      upperLimitPercent: 80,
      lowerLimitPercent: 100,
    },
    calibration: { phase: "Idle" },
  },
  hardware: {
    cycleCount: 348,
    designCapacityMah: 8694,
    rawMaxCapacityMah: 7455,
    temperatureCelsius: 29.99,
  },
  pauseUntilEpoch: null,
};

describe("battery command", () => {
  beforeEach(() => {
    collectMock.mockReset();
  });

  it("renders the live snapshot without a stale-data banner", async () => {
    collectMock.mockResolvedValue(snapshot);
    const renderer = await renderCommand(<Battery />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    const panel = imageSvg(markdown, "Battery");
    expect(panel).toContain(">76<");
    expect(panel).toContain("Charging · 12.3 W · limit 80%");
    expect(panel).toContain("348 cycles");
    const metrics = imageSvg(markdown, "Metrics");
    expect(metrics).toContain(">30.0<");
    expect(metrics).toContain(">Plugged in<");
    expect(markdown).not.toContain("|");
    expect(markdown).not.toContain("Battery data unavailable");
    assertNoBadSubstrings(markdown, "battery live snapshot");
  });

  it("shows the offline banner over cached data when a refresh fails", async () => {
    collectMock.mockResolvedValueOnce(snapshot);
    const renderer = await renderCommand(<Battery />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );

    collectMock.mockRejectedValue(new Error("batt: command not found"));
    const refresh = renderer.root
      .findAllByType(Action)
      .find((a) => a.props.title === "Refresh")!;
    await act(async () => {
      refresh.props.onAction();
    });
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );

    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    expect(markdown).toContain("Battery data unavailable");
    // still showing the last cached snapshot
    expect(imageSvg(markdown, "Battery")).toContain("Charging");
    assertNoBadSubstrings(markdown, "battery offline banner");
  });
});
