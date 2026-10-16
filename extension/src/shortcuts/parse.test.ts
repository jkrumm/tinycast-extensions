import { describe, expect, it } from "vitest";
import { SETTINGS_PLIST_FIXTURE } from "./fixtures";
import {
  parseAppIndex,
  parseBinding,
  parseCommands,
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
    expect(settings.hyperKeyPhysicalKey).toBeNull();
    expect(settings.hyperKeyIncludesShift).toBe(false);
  });

  it("reads Tinycast's own Hyper Key settings", () => {
    const plist = (physical: string, shift: string) =>
      `<plist><dict>
  <key>hyperKeyPhysicalKey</key>${physical}
  <key>hyperKeyIncludesShift</key>${shift}
</dict></plist>`;
    const on = parseTinycastSettings(
      plist("<string>capsLock</string>", "<true/>"),
    );
    expect(on.hyperKeyPhysicalKey).toBe("capsLock");
    expect(on.hyperKeyIncludesShift).toBe(true);
    const off = parseTinycastSettings(
      plist("<string>none</string>", "<false/>"),
    );
    expect(off.hyperKeyPhysicalKey).toBeNull();
    expect(off.hyperKeyIncludesShift).toBe(false);
    expect(
      parseTinycastSettings(plist("<string/>", "<string>x</string>")),
    ).toMatchObject({
      hyperKeyPhysicalKey: null,
      hyperKeyIncludesShift: false,
    });
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
      hyperKeyPhysicalKey: null,
      hyperKeyIncludesShift: false,
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

describe("parseCommands", () => {
  it("maps command names to title and icon and tolerates garbage", () => {
    expect(
      parseCommands(
        '{"commands":[{"name":"hub","title":"Dashboard","icon":"hub.png"},{"name":"bg","title":"Background"},{"name":"x"}]}',
      ),
    ).toEqual({
      hub: { title: "Dashboard", icon: "hub.png" },
      bg: { title: "Background" },
    });
    expect(parseCommands("not json")).toEqual({});
  });
});

describe("parseAppIndex", () => {
  it("maps bundle ids to name and path, first hit wins, skips junk lines", () => {
    expect(
      parseAppIndex(
        "md.obsidian\tObsidian\t/Applications/Obsidian.app\ncom.google.Chrome\tGoogle Chrome\t/Applications/Google Chrome.app\nmd.obsidian\tObsidian Copy\t/x\n\nbroken\nno.path\tNoPath\n",
      ),
    ).toEqual({
      "md.obsidian": { name: "Obsidian", path: "/Applications/Obsidian.app" },
      "com.google.Chrome": {
        name: "Google Chrome",
        path: "/Applications/Google Chrome.app",
      },
      "no.path": { name: "NoPath" },
    });
  });
});
