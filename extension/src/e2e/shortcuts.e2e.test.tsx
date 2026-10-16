import { describe, it, expect, vi } from "vitest";
import React from "react";
import { Action, Detail } from "@raycast/api";
import { renderCommand, waitFor, assertNoBadSubstrings } from "./render";
import { ShortcutsData } from "../shortcuts/format";
import { parseTinycastSettings } from "../shortcuts/parse";
import { SETTINGS_PLIST_FIXTURE } from "../shortcuts/fixtures";

const data: ShortcutsData = {
  settings: parseTinycastSettings(SETTINGS_PLIST_FIXTURE),
  appNames: { "md.obsidian": "Obsidian", "dev.zed.Zed": "Zed" },
  commandTitles: {
    hub: "Dashboard",
    "claude-usage": "Claude Usage",
    "van-power": "Van Power",
  },
};

const loadMock = vi.fn<() => Promise<ShortcutsData>>();
vi.mock("../shortcuts/load", () => ({
  loadShortcuts: () => loadMock(),
}));

import Shortcuts from "../shortcuts";

describe("shortcuts command", () => {
  it("renders every section from the fixture", async () => {
    loadMock.mockResolvedValue(data);
    const renderer = await renderCommand(<Shortcuts />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    assertNoBadSubstrings(markdown, "shortcuts");
    expect(markdown).toContain("Free Hyper letters:");
    expect(markdown).toContain("## Hyper ⇪ — apps");
    expect(markdown).toContain("| ⇪O | Obsidian |");
    expect(markdown).toContain("| ⇪Z | Zed |");
    expect(markdown).toContain("## Hyper ⇪ — extension commands");
    expect(markdown).toContain("| ⇪U | Claude Usage |");
    expect(markdown).toContain("| ⌘Space | Toggle palette |");
    expect(markdown).toContain("| cu | Claude Usage |");
    expect(markdown).toContain("| ⌘8 | Van Power |");

    const copy = renderer.root.findAllByType(Action.CopyToClipboard);
    expect(copy).toHaveLength(1);
    expect(copy[0].props.content).toBe(markdown);
  });

  it("explains a failed read instead of crashing", async () => {
    loadMock.mockRejectedValue(new Error("defaults: domain not found"));
    const renderer = await renderCommand(<Shortcuts />);
    await waitFor(() =>
      (renderer.root.findByType(Detail).props.markdown as string).includes(
        "Could not read",
      ),
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    expect(markdown).toContain("domain not found");
  });
});
