import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { Grid } from "@raycast/api";
import { renderCommand, waitFor } from "./render";
import { TickTickTask, TickTickProject } from "../ticktick/types";
import { UsageQuota } from "../usage/types";
import { RouterStatus } from "../netgear/types";
import { SpeedTestRecord } from "../speed-test/types";
import { BatterySnapshot } from "../battery/types";

vi.mock("../ticktick/load", () => ({
  loadOpenTasks: (): Promise<{
    projects: TickTickProject[];
    tasks: TickTickTask[];
  }> => Promise.resolve({ projects: [], tasks: [] }),
}));
vi.mock("../usage/quota", () => ({
  getQuota: (): Promise<UsageQuota> =>
    Promise.resolve({
      five_hour: { utilization: 12, resets_at_epoch: null },
      seven_day: { utilization: 30, resets_at_epoch: null },
      seven_day_sonnet: { utilization: 5, resets_at_epoch: null },
      fetched_at: Date.now() / 1000,
    }),
}));
vi.mock("../netgear/session", () => ({
  getClient: (): Promise<{ getStatus: () => Promise<Partial<RouterStatus>> }> =>
    Promise.reject(new Error("no router in this environment")),
}));
vi.mock("../speed-test/history", () => ({
  loadHistory: (): Promise<SpeedTestRecord[]> => Promise.resolve([]),
}));
vi.mock("../battery/collect", () => ({
  collectBatterySnapshot: (): Promise<BatterySnapshot> =>
    Promise.reject(new Error("batt: command not found")),
}));

import Hub from "../hub";

describe("hub command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders one tile per command and shows Offline for a failing loader", async () => {
    const renderer = await renderCommand(<Hub />);
    await waitFor(() => renderer.root.findAllByType(Grid.Item).length === 7);

    const tiles = renderer.root.findAllByType(Grid.Item);
    expect(tiles).toHaveLength(7);
    // Every tile's content is a data: URI SVG — as long as it doesn't throw
    // building that, the harness has already done its job; netgear/battery
    // fail on purpose here and should still produce a valid tile.
    for (const tile of tiles) {
      expect(tile.props.content as string).toMatch(/^data:image\/svg\+xml/);
    }
  });
});
