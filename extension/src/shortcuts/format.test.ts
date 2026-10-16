import { describe, expect, it } from "vitest";
import { SETTINGS_PLIST_FIXTURE } from "./fixtures";
import {
  ShortcutsData,
  formatBinding,
  freeHyperLetters,
  hubStatus,
  hyperChord,
  keyLabel,
  shortcutSections,
  shortcutsMarkdown,
} from "./format";
import { TinycastSettings, parseTinycastSettings } from "./parse";

const combo = (modifiers: number, keyCode: number) =>
  ({ kind: "combo", modifiers, keyCode }) as const;

const KARABINER = 6656; // ⌃⌥⇧
const TINYCAST = 6400; // ⌃⌥⌘
const TINYCAST_SHIFT = 6912; // ⌃⌥⇧⌘

const settingsOf = (
  overrides: Partial<TinycastSettings> = {},
): TinycastSettings => ({
  hotkeys: {},
  aliases: {},
  favorites: [],
  hyperKeyPhysicalKey: null,
  hyperKeyIncludesShift: false,
  ...overrides,
});

const bound = (modifiers: number, keyCode: number) =>
  JSON.stringify({
    combo: { _0: { carbonModifiers: modifiers, carbonKeyCode: keyCode } },
  });

describe("hyperChord", () => {
  it("is Karabiner's ⌃⌥⇧ without a Tinycast Hyper Key", () => {
    expect(hyperChord(settingsOf())).toBe(KARABINER);
  });

  it("is ⌃⌥⌘ for Tinycast's Hyper Key, plus ⇧ when it includes shift", () => {
    expect(hyperChord(settingsOf({ hyperKeyPhysicalKey: "capsLock" }))).toBe(
      TINYCAST,
    );
    expect(
      hyperChord(
        settingsOf({
          hyperKeyPhysicalKey: "capsLock",
          hyperKeyIncludesShift: true,
        }),
      ),
    ).toBe(TINYCAST_SHIFT);
  });

  it("ignores the shift flag while no physical key is set", () => {
    expect(hyperChord(settingsOf({ hyperKeyIncludesShift: true }))).toBe(
      KARABINER,
    );
  });
});

describe("formatBinding", () => {
  it("renders the exact chord as Hyper for all three chords", () => {
    expect(formatBinding(combo(KARABINER, 17), KARABINER)).toBe("Hyper T");
    expect(formatBinding(combo(TINYCAST, 17), TINYCAST)).toBe("Hyper T");
    expect(formatBinding(combo(TINYCAST_SHIFT, 17), TINYCAST_SHIFT)).toBe(
      "Hyper T",
    );
  });

  it("renders a superset of the chord as Hyper plus the extra modifiers", () => {
    expect(formatBinding(combo(KARABINER | 256, 17), KARABINER)).toBe(
      "Hyper ⌘T",
    );
    expect(formatBinding(combo(TINYCAST_SHIFT, 17), TINYCAST)).toBe("Hyper ⇧T");
  });

  it("does not call a different chord Hyper", () => {
    expect(formatBinding(combo(KARABINER, 17), TINYCAST)).toBe("⌃⌥⇧T");
    expect(formatBinding(combo(TINYCAST, 17), KARABINER)).toBe("⌃⌥⌘T");
  });

  it("renders other modifiers in ⌃⌥⇧⌘ order", () => {
    expect(formatBinding(combo(256, 49), KARABINER)).toBe("⌘Space");
    expect(formatBinding(combo(256 | 512 | 2048, 36), TINYCAST)).toBe(
      "⌥⇧⌘Return",
    );
    expect(formatBinding(combo(4096 | 256, 122), KARABINER)).toBe("⌃⌘F1");
    expect(formatBinding(combo(2048, 126), KARABINER)).toBe("⌥↑");
  });

  it("renders non-combo kinds by name and unknown keys by number", () => {
    expect(formatBinding({ kind: "other", name: "doubleTap" }, KARABINER)).toBe(
      "doubleTap",
    );
    expect(keyLabel(999)).toBe("key 999");
  });
});

describe("keyboard layout", () => {
  it("prints US labels for the US layout and unknown layouts", () => {
    for (const layout of ["com.apple.keylayout.US", ""]) {
      expect(keyLabel(6, layout)).toBe("Z");
      expect(keyLabel(16, layout)).toBe("Y");
    }
  });

  it("swaps Y and Z on German, Swiss and Austrian layouts only", () => {
    for (const layout of [
      "com.apple.keylayout.German",
      "com.apple.keylayout.SwissGerman",
      "com.apple.keylayout.Swiss",
      "com.apple.keylayout.Austrian",
    ]) {
      expect(keyLabel(6, layout)).toBe("Y");
      expect(keyLabel(16, layout)).toBe("Z");
      expect(keyLabel(17, layout)).toBe("T");
      expect(formatBinding(combo(TINYCAST, 6), TINYCAST, layout)).toBe(
        "Hyper Y",
      );
    }
  });
});

describe("freeHyperLetters", () => {
  it("lists letters not bound under exactly the Hyper chord", () => {
    const settings = parseTinycastSettings(SETTINGS_PLIST_FIXTURE);
    const free = freeHyperLetters(settings);
    expect(free).toHaveLength(26 - 15);
    expect(free).not.toContain("T");
    expect(free).toContain("B");
    expect(free).toEqual([...free].sort());
  });

  it("does not count a Hyper+⌘ binding", () => {
    const free = freeHyperLetters(
      settingsOf({ hotkeys: { "app.a": bound(6912, 0) } }),
    );
    expect(free).toContain("A");
  });

  it("uses the Tinycast chord and the printed labels", () => {
    const settings = settingsOf({
      hyperKeyPhysicalKey: "capsLock",
      hotkeys: {
        "app.hub": bound(TINYCAST, 6),
        "app.karabiner": bound(KARABINER, 0),
      },
    });
    expect(freeHyperLetters(settings, "com.apple.keylayout.German")).toEqual(
      expect.not.arrayContaining(["Y"]),
    );
    expect(freeHyperLetters(settings, "com.apple.keylayout.German")).toContain(
      "Z",
    );
    expect(freeHyperLetters(settings)).toContain("Y");
    expect(freeHyperLetters(settings)).not.toContain("Z");
    // ⌃⌥⇧A is not Hyper while Tinycast's chord is
    expect(freeHyperLetters(settings)).toContain("A");
  });
});

describe("hubStatus", () => {
  it("pluralises", () => {
    expect(hubStatus(1)).toBe("1 hotkey");
    expect(hubStatus(16)).toBe("16 hotkeys");
  });
});

describe("shortcutSections", () => {
  const data: ShortcutsData = {
    settings: parseTinycastSettings(SETTINGS_PLIST_FIXTURE),
    apps: {
      "md.obsidian": { name: "Obsidian", path: "/Applications/Obsidian.app" },
      "dev.zed.Zed": { name: "Zed", path: "/Applications/Zed.app" },
      "com.google.Chrome": { name: "Google Chrome" },
    },
    commands: {
      hub: { title: "Dashboard", icon: "hub.png" },
      "van-power": { title: "Van Power", icon: "van.png" },
    },
    layout: "com.apple.keylayout.German",
  };
  const sections = shortcutSections(data);
  const section = (title: string) => sections.find((s) => s.title === title);

  it("builds the sections in order with the free letters on the first", () => {
    expect(sections.map((s) => s.title)).toEqual([
      "Hyper — Apps",
      "Hyper — Commands",
      "Tinycast",
      "Aliases",
      "Favorites",
    ]);
    expect(section("Hyper — Apps")?.subtitle).toMatch(/^free: [A-Z]( [A-Z])*$/);
    expect(section("Hyper — Commands")?.subtitle).toBeUndefined();
  });

  it("gives apps their icon path, bundle id launch and Hyper tag", () => {
    const obsidian = section("Hyper — Apps")?.rows.find(
      (r) => r.title === "Obsidian",
    );
    expect(obsidian).toMatchObject({
      key: "Hyper O",
      icon: { kind: "app", path: "/Applications/Obsidian.app" },
      launch: { kind: "app", bundleId: "md.obsidian" },
    });
    const chrome = section("Hyper — Apps")?.rows.find(
      (r) => r.title === "Google Chrome",
    );
    expect(chrome?.icon).toEqual({ kind: "fallback" });
    // not in the app scan: raw id, still launchable
    const unknown = section("Hyper — Apps")?.rows.find(
      (r) => r.title === "com.goodsnooze.MacWhisper",
    );
    expect(unknown?.launch).toEqual({
      kind: "app",
      bundleId: "com.goodsnooze.MacWhisper",
    });
  });

  it("gives commands the manifest icon, a launchCommand target and layout-aware keys", () => {
    const commands = section("Hyper — Commands")?.rows ?? [];
    // keycode 16 (US Y) prints Z on the German layout
    expect(commands.find((r) => r.title === "Dashboard")).toMatchObject({
      key: "Hyper Z",
      icon: { kind: "asset", file: "hub.png" },
      launch: { kind: "command", name: "hub" },
    });
    // command missing from the manifest: raw name, fallback icon
    expect(commands.find((r) => r.title === "quick-add")?.icon).toEqual({
      kind: "fallback",
    });
    const keys = commands.map((r) => r.key ?? "");
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it("puts the palette first under Tinycast, without a launch target", () => {
    const [first] = section("Tinycast")?.rows ?? [];
    expect(first).toMatchObject({
      title: "Toggle palette",
      key: "⌘Space",
      launch: null,
    });
  });

  it("shows aliases and ⌘N favorites", () => {
    const alias = section("Aliases")?.rows.find((r) => r.title === "battery");
    expect(alias?.key).toBe("bt");
    const favorites = section("Favorites")?.rows ?? [];
    expect(favorites[0]).toMatchObject({ title: "Dashboard", key: "⌘1" });
    expect(favorites[7]).toMatchObject({ title: "Van Power", key: "⌘8" });
  });

  it("leaves favorites past the tenth without a key and drops empty sections", () => {
    const out = shortcutSections({
      ...data,
      settings: settingsOf({
        favorites: Array.from({ length: 11 }, (_, i) => `app.${i}`),
      }),
    });
    expect(out.map((s) => s.title)).toEqual(["Favorites"]);
    expect(out[0].rows[9].key).toBe("⌘0");
    expect(out[0].rows[10].key).toBeNull();
  });

  it("keeps foreign extension commands under Tinycast and shows the chord", () => {
    const out = shortcutSections({
      settings: settingsOf({
        hyperKeyPhysicalKey: "capsLock",
        hotkeys: {
          "command.clipboard": '{"doubleTap":{}}',
          "extensionCommand.extension:other/x": bound(256, 8),
          "app.md.obsidian": bound(TINYCAST, 31),
          "app.md.other": bound(TINYCAST_SHIFT, 31),
        },
      }),
      apps: {},
      commands: {},
      layout: "",
    });
    expect(out.map((s) => s.title)).toEqual(["Hyper — Apps", "Tinycast"]);
    expect(out[0].rows.map((r) => r.key).sort()).toEqual([
      "Hyper O",
      "Hyper ⇧O",
    ]);
    expect(out[1].rows.map((r) => [r.title, r.key])).toEqual([
      ["extensionCommand.extension:other/x", "⌘C"],
      ["command.clipboard", "doubleTap"],
    ]);
  });
});

describe("shortcutsMarkdown", () => {
  it("renders the sections as Key | Name tables with Hyper labels", () => {
    const markdown = shortcutsMarkdown({
      settings: parseTinycastSettings(SETTINGS_PLIST_FIXTURE),
      apps: { "md.obsidian": { name: "Obsidian" } },
      commands: { hub: { title: "Dashboard" } },
      layout: "",
    });
    expect(markdown).toContain("## Hyper — Apps");
    expect(markdown).toContain("_free: ");
    expect(markdown).toContain("| Hyper O | Obsidian |");
    expect(markdown).toContain("| Hyper Y | Dashboard |");
    expect(markdown).toContain("| ⌘Space | Toggle palette |");
    expect(markdown).toContain("| bt | battery |");
    expect(markdown).toContain("| ⌘1 | Dashboard |");
    expect(markdown).toContain("|-|-|");
    expect(markdown).not.toContain("⇪");
  });
});
