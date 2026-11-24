// Sample input for the Hyper key sheet tests: a German layout, Caps Lock as
// Tinycast's Hyper Key, three apps, one command, the palette and the WalkingPad
// app's three keys. Nothing from the real domains is copied here.

import { RowIcon, ShortcutsData } from "./format";
import { parseWalkingPadHotkeys, TinycastSettings } from "./parse";
import { WALKINGPAD_PLIST_FIXTURE } from "./fixtures";
import { HyperSheetInput, WALKINGPAD_BUNDLE_ID } from "./sheet";

const binding = (modifiers: number, keyCode: number) =>
  JSON.stringify({
    combo: { _0: { carbonModifiers: modifiers, carbonKeyCode: keyCode } },
  });

const TINYCAST_HYPER = 6400; // ⌃⌥⌘

const settings: TinycastSettings = {
  hotkeys: {
    "app.md.obsidian": binding(TINYCAST_HYPER, 31), // O
    "app.dev.zed.Zed": binding(TINYCAST_HYPER, 16), // prints Z on German
    "app.net.imput.helium": binding(TINYCAST_HYPER, 4), // H
    "app.com.apple.Safari": binding(256, 1), // ⌘S, not Hyper
    "extensionCommand.extension:jkrumm/hub": binding(TINYCAST_HYPER, 6), // prints Y on German
    togglePalette: binding(256, 49), // ⌘Space
  },
  aliases: {},
  favorites: [],
  hyperKeyPhysicalKey: "capsLock",
  hyperKeyIncludesShift: false,
};

export const sampleData = (): ShortcutsData => ({
  settings,
  apps: {
    "md.obsidian": { name: "Obsidian", path: "/Applications/Obsidian.app" },
    "dev.zed.Zed": { name: "Zed" }, // no bundle path: lettered tile
    "net.imput.helium": {
      name: "Helium <Beta> & Co",
      path: "/Applications/Helium.app",
    },
    [WALKINGPAD_BUNDLE_ID]: {
      name: "WalkingPad",
      path: "/Users/someone/Applications/WalkingPad.app",
    },
  },
  commands: { hub: { title: "Dashboard", icon: "hub.png" } },
  layout: "com.apple.keylayout.German",
});

export const sampleInput = (withWalkingPad = true): HyperSheetInput => ({
  data: sampleData(),
  walkingPad: withWalkingPad
    ? parseWalkingPadHotkeys(WALKINGPAD_PLIST_FIXTURE)
    : null,
  generatedOn: "2026-11-24",
});

// Stand-in icons: the tests check where an icon lands, not its pixels.
export const fakeIcon = (icon: RowIcon): string | null =>
  icon.kind === "fallback" ? null : "data:image/png;base64,ICON";
