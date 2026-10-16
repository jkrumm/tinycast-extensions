import { describe, expect, it } from "vitest";
import { SETTINGS_PLIST_FIXTURE } from "./fixtures";
import {
  ShortcutsData,
  formatBinding,
  freeHyperLetters,
  hubStatus,
  keyLabel,
  shortcutsMarkdown,
} from "./format";
import { parseTinycastSettings } from "./parse";

const combo = (modifiers: number, keyCode: number) =>
  ({ kind: "combo", modifiers, keyCode }) as const;

describe("formatBinding", () => {
  it("renders exactly ⌃⌥⇧ as Hyper and ⌃⌥⇧⌘ as Hyper plus ⌘", () => {
    expect(formatBinding(combo(6656, 17))).toBe("⇪T");
    expect(formatBinding(combo(6656 | 256, 17))).toBe("⇪⌘T");
  });

  it("renders other modifiers in ⌃⌥⇧⌘ order", () => {
    expect(formatBinding(combo(256, 49))).toBe("⌘Space");
    expect(formatBinding(combo(256 | 512 | 2048, 36))).toBe("⌥⇧⌘Return");
    expect(formatBinding(combo(4096 | 256, 122))).toBe("⌃⌘F1");
    expect(formatBinding(combo(2048, 126))).toBe("⌥↑");
  });

  it("renders non-combo kinds by name and unknown keys by number", () => {
    expect(formatBinding({ kind: "other", name: "doubleTap" })).toBe(
      "doubleTap",
    );
    expect(keyLabel(999)).toBe("key 999");
  });
});

describe("freeHyperLetters", () => {
  it("lists letters not bound under exactly ⌃⌥⇧", () => {
    const settings = parseTinycastSettings(SETTINGS_PLIST_FIXTURE);
    const free = freeHyperLetters(settings);
    expect(free).toHaveLength(26 - 15);
    expect(free).not.toContain("T");
    expect(free).toContain("B");
    // ⌘Space (palette) and non-letter keys take no letter
    expect(free).toEqual([...free].sort());
  });

  it("does not count a Hyper+⌘ binding", () => {
    const free = freeHyperLetters({
      hotkeys: {
        "app.a": '{"combo":{"_0":{"carbonModifiers":6912,"carbonKeyCode":0}}}',
      },
      aliases: {},
      favorites: [],
    });
    expect(free).toContain("A");
  });
});

describe("hubStatus", () => {
  it("pluralises", () => {
    expect(hubStatus(1)).toBe("1 hotkey");
    expect(hubStatus(16)).toBe("16 hotkeys");
  });
});

describe("shortcutsMarkdown", () => {
  const data: ShortcutsData = {
    settings: parseTinycastSettings(SETTINGS_PLIST_FIXTURE),
    appNames: {
      "md.obsidian": "Obsidian",
      "com.google.Chrome": "Google Chrome",
    },
    commandTitles: { hub: "Dashboard", "van-power": "Van Power" },
  };
  const markdown = shortcutsMarkdown(data);

  it("has the sections with resolved names and falls back to raw ids", () => {
    expect(markdown).toContain("## Hyper ⇪ — apps");
    expect(markdown).toContain("| ⇪O | Obsidian |");
    expect(markdown).toContain("| ⇪D | com.goodsnooze.MacWhisper |");
    expect(markdown).toContain("## Hyper ⇪ — extension commands");
    expect(markdown).toContain("| ⇪Y | Dashboard |");
    expect(markdown).toContain("| ⇪Q | quick-add |");
    expect(markdown).toContain("| ⌘Space | Toggle palette |");
    expect(markdown).toContain("| bt | battery |");
    expect(markdown).toContain("| ⌘1 | Dashboard |");
    expect(markdown).toContain("| ⌘8 | Van Power |");
    expect(markdown).toContain("Free Hyper letters:");
    expect(markdown).toContain("|-|-|");
  });

  it("sorts each table by key", () => {
    const keys = [...markdown.matchAll(/^\| (⇪\w) \| .* \|$/gm)].map(
      (m) => m[1],
    );
    const apps = keys.slice(0, 10);
    expect(apps).toEqual([...apps].sort((a, b) => a.localeCompare(b)));
  });

  it("puts other Tinycast hotkeys and non-combo bindings under Tinycast", () => {
    const out = shortcutsMarkdown({
      settings: {
        hotkeys: {
          "command.clipboard": '{"doubleTap":{}}',
          "extensionCommand.extension:other/x":
            '{"combo":{"_0":{"carbonModifiers":256,"carbonKeyCode":8}}}',
        },
        aliases: {},
        favorites: [],
      },
      appNames: {},
      commandTitles: {},
    });
    expect(out).toContain("| doubleTap | command.clipboard |");
    expect(out).toContain("| ⌘C | extensionCommand.extension:other/x |");
    expect(out).not.toContain("## Hyper");
    expect(out).toContain("Free Hyper letters: A B C");
  });
});
