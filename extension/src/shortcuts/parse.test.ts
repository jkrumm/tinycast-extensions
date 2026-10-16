import { describe, expect, it } from "vitest";
import { SETTINGS_PLIST_FIXTURE } from "./fixtures";
import {
  parseAppIndex,
  parseBinding,
  parseCommandTitles,
  parseTinycastSettings,
} from "./parse";

describe("parseTinycastSettings", () => {
  it("reads hotkeys, aliases and favorites from the fixture", () => {
    const settings = parseTinycastSettings(SETTINGS_PLIST_FIXTURE);
    expect(Object.keys(settings.hotkeys)).toHaveLength(16);
    expect(settings.hotkeys["app.md.obsidian"]).toBe(
      '{"combo":{"_0":{"carbonModifiers":6656,"carbonKeyCode":31}}}',
    );
    expect(settings.hotkeys.togglePalette).toContain("carbonKeyCode");
    expect(settings.aliases["extension:jkrumm/battery"]).toBe("bt");
    expect(settings.favorites[0]).toBe("extension:jkrumm/hub");
    expect(settings.favorites).toHaveLength(8);
  });

  it("ignores data, date, bool, number and nested values it does not need", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>customCommands</key><data>
  W10=
  </data>
  <key>lastRun</key><date>2026-10-16T08:00:00Z</date>
  <key>flag</key><true/>
  <key>off</key><false/>
  <key>count</key><integer>3</integer>
  <key>empty</key><string/>
  <key>nested</key><dict><key>a</key><array><dict><key>b</key><string>c</string></dict></array></dict>
  <key>hotkey.command.a&amp;b</key><string>{"doubleTap":{}}</string>
  <key>hotkey.skipped</key><integer>1</integer>
  <key>favoriteApps</key><array><string>md.obsidian</string><true/></array>
  <key>launcherAliases</key><dict><key>x</key><string>y</string><key>z</key><true/></dict>
</dict></plist>`;
    expect(parseTinycastSettings(xml)).toEqual({
      hotkeys: { "command.a&b": '{"doubleTap":{}}' },
      aliases: { x: "y" },
      favorites: ["md.obsidian"],
    });
  });

  it("throws on a plist that is cut off", () => {
    expect(() =>
      parseTinycastSettings("<plist><dict><key>a</key><string>b"),
    ).toThrow();
  });
});

describe("parseBinding", () => {
  it("reads a key combo", () => {
    expect(
      parseBinding(
        '{"combo":{"_0":{"carbonModifiers":6656,"carbonKeyCode":17}}}',
      ),
    ).toEqual({ kind: "combo", modifiers: 6656, keyCode: 17 });
  });

  it("reports other kinds by name and never throws", () => {
    expect(parseBinding('{"doubleTap":{"_0":{"x":1}}}')).toEqual({
      kind: "other",
      name: "doubleTap",
    });
    expect(parseBinding('{"globe":{}}')).toEqual({
      kind: "other",
      name: "globe",
    });
    expect(parseBinding('{"combo":{}}')).toEqual({
      kind: "other",
      name: "combo",
    });
    for (const raw of ["", "nope", "null", "42", "{}"]) {
      expect(parseBinding(raw)).toEqual({ kind: "other", name: "unknown" });
    }
  });
});

describe("parseCommandTitles", () => {
  it("maps command names to titles and tolerates garbage", () => {
    expect(
      parseCommandTitles(
        '{"commands":[{"name":"hub","title":"Dashboard"},{"name":"x"}]}',
      ),
    ).toEqual({ hub: "Dashboard" });
    expect(parseCommandTitles("not json")).toEqual({});
  });
});

describe("parseAppIndex", () => {
  it("maps bundle ids to names, first hit wins, skips junk lines", () => {
    expect(
      parseAppIndex(
        "md.obsidian\tObsidian\ncom.google.Chrome\tGoogle Chrome\nmd.obsidian\tObsidian Copy\n\nbroken\n",
      ),
    ).toEqual({
      "md.obsidian": "Obsidian",
      "com.google.Chrome": "Google Chrome",
    });
  });
});
