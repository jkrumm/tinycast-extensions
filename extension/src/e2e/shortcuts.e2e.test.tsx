import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { Action, List } from "@raycast/api";
import { renderCommand, waitFor, assertNoBadSubstrings } from "./render";
import { __closedMainWindow } from "./raycast-fake";
import { LaunchTarget, ShortcutsData } from "../shortcuts/format";
import { parseTinycastSettings } from "../shortcuts/parse";
import { SETTINGS_PLIST_FIXTURE } from "../shortcuts/fixtures";

const data: ShortcutsData = {
  settings: parseTinycastSettings(SETTINGS_PLIST_FIXTURE),
  apps: {
    "md.obsidian": { name: "Obsidian", path: "/Applications/Obsidian.app" },
    "dev.zed.Zed": { name: "Zed", path: "/Applications/Zed.app" },
  },
  commands: {
    hub: { title: "Dashboard", icon: "hub.png" },
    "claude-usage": { title: "Claude Usage", icon: "usage.png" },
    "van-power": { title: "Van Power", icon: "van.png" },
  },
  layout: "com.apple.keylayout.German",
};

const loadMock = vi.fn<() => Promise<ShortcutsData>>();
const launchMock = vi.fn<(target: LaunchTarget) => Promise<void>>();
vi.mock("../shortcuts/load", () => ({
  loadShortcuts: () => loadMock(),
  launchTarget: (target: LaunchTarget) => launchMock(target),
}));

import Shortcuts from "../shortcuts";

const itemProps = (renderer: Awaited<ReturnType<typeof renderCommand>>) =>
  renderer.root.findAllByType(List.Item).map((item) => item.props);

describe("shortcuts command", () => {
  beforeEach(() => {
    launchMock.mockReset();
    launchMock.mockResolvedValue(undefined);
  });

  it("renders every section and row from the fixture", async () => {
    loadMock.mockResolvedValue(data);
    const renderer = await renderCommand(<Shortcuts />);
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );

    const sections = renderer.root.findAllByType(List.Section);
    expect(sections.map((s) => s.props.title)).toEqual([
      "Hyper — Apps",
      "Hyper — Commands",
      "Tinycast",
      "Aliases",
      "Favorites",
    ]);
    expect(sections[0].props.subtitle).toMatch(/^free: [A-Z]( [A-Z])*$/);

    const items = itemProps(renderer);
    const row = (title: string, tag: string) =>
      items.find(
        (item) =>
          item.title === title &&
          (item.accessories as { tag: string }[])[0]?.tag === tag,
      );
    // keycode 6 is printed Y and 16 Z on the German layout
    expect(row("Zed", "Hyper Y")?.icon).toEqual({
      fileIcon: "/Applications/Zed.app",
    });
    expect(row("Obsidian", "Hyper O")).toBeDefined();
    expect(row("Dashboard", "Hyper Z")?.icon).toBe("hub.png");
    expect(row("Claude Usage", "Hyper U")?.icon).toBe("usage.png");
    expect(row("Toggle palette", "⌘Space")).toBeDefined();
    expect(row("Claude Usage", "cu")).toBeDefined();
    expect(row("Van Power", "⌘8")).toBeDefined();
    // an app the scan didn't find
    expect(row("com.google.Chrome", "Hyper C")?.icon).toBe("icon:AppWindow");

    for (const item of items) {
      assertNoBadSubstrings(String(item.title), "shortcuts title");
      assertNoBadSubstrings(JSON.stringify(item.accessories), "shortcuts tag");
    }
  });

  it("launches an app by bundle id and a command by name", async () => {
    loadMock.mockResolvedValue(data);
    const renderer = await renderCommand(<Shortcuts />);
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );
    const closedBefore = __closedMainWindow.count;

    const openAction = (title: string, tag: string) => {
      const item = renderer.root
        .findAllByType(List.Item)
        .find(
          (i) =>
            i.props.title === title &&
            (i.props.accessories as { tag: string }[])[0]?.tag === tag,
        );
      return item!.findAllByType(Action).find((a) => a.props.title === "Open")!;
    };

    await openAction("Obsidian", "Hyper O").props.onAction();
    expect(launchMock).toHaveBeenLastCalledWith({
      kind: "app",
      bundleId: "md.obsidian",
    });
    expect(__closedMainWindow.count).toBe(closedBefore + 1);
    await openAction("Dashboard", "Hyper Z").props.onAction();
    expect(launchMock).toHaveBeenLastCalledWith({
      kind: "command",
      name: "hub",
    });
    expect(__closedMainWindow.count).toBe(closedBefore + 1);
  });

  it("offers Copy as Markdown and Refresh, and no Open on Tinycast rows", async () => {
    loadMock.mockResolvedValue(data);
    const renderer = await renderCommand(<Shortcuts />);
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );
    const palette = renderer.root
      .findAllByType(List.Item)
      .find((i) => i.props.title === "Toggle palette")!;
    expect(palette.findAllByType(Action).map((a) => a.props.title)).toEqual([
      "Refresh",
    ]);
    const copy = palette.findAllByType(Action.CopyToClipboard);
    expect(copy).toHaveLength(1);
    expect(copy[0].props.content).toContain("| Hyper O | Obsidian |");
  });

  it("explains a failed read instead of crashing", async () => {
    loadMock.mockRejectedValue(new Error("defaults: domain not found"));
    const renderer = await renderCommand(<Shortcuts />);
    await waitFor(() => renderer.root.findAllByType(List.EmptyView).length > 0);
    const empty = renderer.root.findByType(List.EmptyView);
    expect(empty.props.title).toContain("Could not read");
    expect(empty.props.description).toContain("domain not found");
  });
});
