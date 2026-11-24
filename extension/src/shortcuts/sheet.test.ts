import { describe, expect, it } from "vitest";
import { sampleData, sampleInput, fakeIcon } from "./sheet-fixtures";
import {
  KEYBOARD_HEIGHT,
  KEYBOARD_WIDTH,
  HyperSheet,
  buildHyperSheet,
  hyperTitle,
} from "./sheet";
import { TinycastSettings } from "./parse";

const build = (withWalkingPad = true): HyperSheet =>
  buildHyperSheet(sampleInput(withWalkingPad), fakeIcon);

const entryAt = (sheet: HyperSheet, keyCode: number) =>
  sheet.entries.find((entry) => entry.keyCode === keyCode);

const keyAt = (sheet: HyperSheet, keyCode: number) =>
  sheet.keyboard.keys.find((key) => key.keyCode === keyCode);

const settingsWith = (
  overrides: Partial<TinycastSettings>,
): TinycastSettings => ({ ...sampleData().settings, ...overrides });

describe("hyperTitle", () => {
  it("names Caps Lock and the chord, with ⇧ when the Hyper Key includes it", () => {
    expect(hyperTitle(settingsWith({ hyperKeyPhysicalKey: "capsLock" }))).toBe(
      "Hyper = Caps Lock (⌃⌥⌘)",
    );
    expect(
      hyperTitle(
        settingsWith({
          hyperKeyPhysicalKey: "capsLock",
          hyperKeyIncludesShift: true,
        }),
      ),
    ).toBe("Hyper = Caps Lock (⌃⌥⇧⌘)");
  });

  it("falls back to Karabiner's chord when no Hyper Key is configured", () => {
    expect(hyperTitle(settingsWith({ hyperKeyPhysicalKey: null }))).toBe(
      "Hyper = ⌃⌥⇧",
    );
  });
});

describe("buildHyperSheet", () => {
  it("puts each Hyper target on its key, labelled for the German layout", () => {
    const sheet = build();
    // Zed is US Y's position (16), which the German layout prints as Z.
    expect(entryAt(sheet, 16)).toMatchObject({
      group: "apps",
      cap: "Z",
      name: "Zed",
      icon: null,
    });
    expect(keyAt(sheet, 16)?.label).toBe("Z");
    // The dashboard command is keycode 6, printed Y on German.
    expect(entryAt(sheet, 6)).toMatchObject({
      group: "commands",
      cap: "Y",
      name: "Dashboard",
      icon: "data:image/png;base64,ICON",
    });
    expect(keyAt(sheet, 6)?.label).toBe("Y");
  });

  it("leaves out combos that are not the Hyper chord", () => {
    expect(entryAt(build(), 1)).toBeUndefined();
  });

  it("lists the WalkingPad keys in their own group, with Delete and the arrows on their caps", () => {
    const sheet = build();
    const walkingPad = sheet.entries.filter(
      (entry) => entry.group === "walkingpad",
    );
    expect(walkingPad).toHaveLength(3);
    expect(walkingPad.every((entry) => entry.owner === "WalkingPad")).toBe(
      true,
    );
    expect(walkingPad).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cap: "Delete",
          short: "Belt",
          name: "Start / stop belt",
        }),
        expect.objectContaining({ cap: "↑", short: "Faster", name: "Faster" }),
        expect.objectContaining({ cap: "↓", short: "Slower", name: "Slower" }),
      ]),
    );
    expect(keyAt(sheet, 51)).toMatchObject({ label: "Delete", w: 2 });
    expect(keyAt(sheet, 126)?.label).toBe("↑");
    expect(keyAt(sheet, 123)?.label).toBe("←");
  });

  it("drops the WalkingPad group when its domain is missing", () => {
    const sheet = build(false);
    expect(sheet.entries.some((entry) => entry.group === "walkingpad")).toBe(
      false,
    );
    expect(entryAt(sheet, 126)).toBeUndefined();
  });

  it("orders the legend by group, then by key", () => {
    const groups = build().entries.map((entry) => entry.group);
    expect(groups).toEqual(
      [...groups].sort((a, b) => groupRank(a) - groupRank(b)),
    );
    const apps = build().entries.filter((entry) => entry.group === "apps");
    expect(apps.map((entry) => entry.cap)).toEqual(["H", "O", "Z"]);
  });

  it("reads the palette shortcut live, and leaves it out when unset", () => {
    expect(build().palette).toBe("⌘Space");
    const noPalette = buildHyperSheet(
      {
        ...sampleInput(),
        data: {
          ...sampleData(),
          settings: settingsWith({ hotkeys: {} }),
        },
      },
      fakeIcon,
    );
    expect(noPalette.palette).toBeNull();
  });

  it("marks Caps Lock as the Hyper key only when Tinycast maps it", () => {
    expect(keyAt(build(), 57)?.hyper).toBe(true);
    const otherKey = buildHyperSheet(
      {
        ...sampleInput(),
        data: {
          ...sampleData(),
          settings: settingsWith({ hyperKeyPhysicalKey: null }),
        },
      },
      fakeIcon,
    );
    expect(keyAt(otherKey, 57)?.hyper).toBe(false);
  });

  it("lays the keys out inside the keyboard without overlaps", () => {
    const { keys } = build().keyboard;
    for (const key of keys) {
      expect(key.x + key.w).toBeLessThanOrEqual(KEYBOARD_WIDTH);
      expect(key.y).toBeLessThan(KEYBOARD_HEIGHT);
    }
    for (const key of keys) {
      const neighbours = keys.filter(
        (other) =>
          other !== key &&
          other.y === key.y &&
          other.x >= key.x &&
          other.x < key.x + key.w,
      );
      expect(neighbours).toEqual([]);
    }
  });

  it("passes the generation date and the keyboard size through", () => {
    const sheet = build();
    expect(sheet.generatedOn).toBe("2026-11-24");
    expect(sheet.keyboard).toMatchObject({
      width: KEYBOARD_WIDTH,
      height: KEYBOARD_HEIGHT,
    });
  });
});

function groupRank(group: string): number {
  return ["apps", "commands", "walkingpad"].indexOf(group);
}
