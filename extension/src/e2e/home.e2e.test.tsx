import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { Action, List } from "@raycast/api";
import { renderCommand, waitFor } from "./render";
import { HomeCache, StatusCache } from "../home/types";

const cache: HomeCache = {
  scenes: [
    { id: "A1", name: "Chill", rooms: ["Wohnzimmer"], actionCount: 29 },
    { id: "B2", name: "Aus", rooms: [], actionCount: 3 },
  ],
  doctor: {
    total: 28,
    unreachable: [
      { name: "Bildschirm", room: "Wohnzimmer", manufacturer: null },
    ],
    lowBattery: [{ name: "Treppe", room: "Schlafzimmer", battery: 1 }],
  },
  fetchedAt: 1,
};

const statusCache: StatusCache = {
  status: {
    climate: {
      sensor: "Eve",
      reachable: true,
      temperatureC: 21.9,
      humidityPct: 42,
      batteryPct: 100,
    },
    namiHome: true,
    someoneHome: true,
  },
  fetchedAt: Date.now(),
  climateAt: Date.now(),
};

const refreshMock = vi.fn<() => Promise<HomeCache>>();
const statusMock = vi.fn<() => Promise<StatusCache>>();
const namiMock = vi.fn<(home: boolean) => Promise<void>>();
const triggerMock = vi.fn<(id: string) => Promise<void>>();
vi.mock("../home/run", () => ({
  localStorageHome: { read: () => Promise.resolve(null) },
  localStorageStatus: { read: () => Promise.resolve(null) },
  refreshStatus: () => statusMock(),
  loadClimate: () => Promise.resolve({ status: null, points: [], at: 0 }),
  namiPresence: (home: boolean) => namiMock(home),
  refreshHome: () => refreshMock(),
  triggerScene: (id: string) => triggerMock(id),
}));

import Home from "../home";

describe("home command", () => {
  beforeEach(() => {
    refreshMock.mockReset();
    triggerMock.mockReset();
    statusMock.mockReset();
    namiMock.mockReset();
    namiMock.mockResolvedValue(undefined);
    statusMock.mockResolvedValue(statusCache);
    triggerMock.mockResolvedValue(undefined);
  });

  it("renders Status, scenes and the Needs attention section", async () => {
    refreshMock.mockResolvedValue(cache);
    const renderer = await renderCommand(<Home />);
    await waitFor(
      () =>
        renderer.root.findByType(List).props.isLoading === false &&
        renderer.root
          .findAllByType(List.Section)
          .some((s) => s.props.title === "Status"),
    );
    expect(
      renderer.root.findAllByType(List.Section).map((s) => s.props.title),
    ).toEqual(["Status", "Scenes", "Needs attention"]);
    expect(
      renderer.root.findAllByType(List.Item).map((i) => i.props.title),
    ).toEqual([
      "21.9° · 42%",
      "Nami is home",
      "Someone home: yes",
      "Chill",
      "Aus",
      "Bildschirm",
      "Treppe",
    ]);
  });

  it("toggles Nami to the opposite state", async () => {
    refreshMock.mockResolvedValue(cache);
    const renderer = await renderCommand(<Home />);
    await waitFor(() =>
      renderer.root
        .findAllByType(List.Item)
        .some((i) => i.props.title === "Nami is home"),
    );
    const nami = renderer.root
      .findAllByType(List.Item)
      .find((i) => i.props.title === "Nami is home")!;
    await nami
      .findAllByType(Action)
      .find((a) => a.props.title === "Nami Comes Along")!
      .props.onAction();
    expect(namiMock).toHaveBeenCalledWith(false);
  });

  it("triggers a scene by id", async () => {
    refreshMock.mockResolvedValue(cache);
    const renderer = await renderCommand(<Home />);
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );
    const chill = renderer.root
      .findAllByType(List.Item)
      .find((i) => i.props.title === "Chill")!;
    await chill
      .findAllByType(Action)
      .find((a) => a.props.title === "Trigger Scene")!
      .props.onAction();
    expect(triggerMock).toHaveBeenCalledWith("A1");
  });

  it("shows the friendly error when nothing is cached and refresh fails", async () => {
    refreshMock.mockRejectedValue(new Error("home: HomeClaw unreachable"));
    const renderer = await renderCommand(<Home />);
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );
    const empty = renderer.root.findByType(List.EmptyView);
    expect(empty.props.description).toMatch(/mini online/);
  });
});
