import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { Action, List } from "@raycast/api";
import { renderCommand, waitFor } from "./render";
import { HomeCache } from "../home/types";

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

const refreshMock = vi.fn<() => Promise<HomeCache>>();
const triggerMock = vi.fn<(id: string) => Promise<void>>();
vi.mock("../home/run", () => ({
  localStorageHome: { read: () => Promise.resolve(null) },
  refreshHome: () => refreshMock(),
  triggerScene: (id: string) => triggerMock(id),
}));

import Home from "../home";

describe("home command", () => {
  beforeEach(() => {
    refreshMock.mockReset();
    triggerMock.mockReset();
    triggerMock.mockResolvedValue(undefined);
  });

  it("renders scenes and the Needs attention section", async () => {
    refreshMock.mockResolvedValue(cache);
    const renderer = await renderCommand(<Home />);
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );
    expect(
      renderer.root.findAllByType(List.Section).map((s) => s.props.title),
    ).toEqual(["Scenes", "Needs attention"]);
    expect(
      renderer.root.findAllByType(List.Item).map((i) => i.props.title),
    ).toEqual(["Chill", "Aus", "Bildschirm", "Treppe"]);
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
