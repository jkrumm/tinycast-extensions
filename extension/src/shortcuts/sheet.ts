// The printable Hyper key sheet as data: every Hyper-bound key with its target,
// the keyboard the caps sit on, and the palette shortcut. Pure, no @raycast/api.
// Rows and chord labels come from format.ts, so the sheet and the Shortcuts
// List can't disagree about what a key does.

import {
  HYPER_APPS,
  HYPER_COMMANDS,
  RowIcon,
  ShortcutRow,
  ShortcutsData,
  formatBinding,
  hyperChord,
  keyLabel,
  modifierGlyphs,
  shortcutSections,
} from "./format";
import { Binding, TinycastSettings, parseBinding } from "./parse";

export const WALKINGPAD_BUNDLE_ID = "com.jkrumm.walkingpad.client";

export type SheetGroup = "apps" | "commands" | "walkingpad";

const GROUP_ORDER: SheetGroup[] = ["apps", "commands", "walkingpad"];

const WALKINGPAD_LABELS: Record<string, { name: string; short: string }> = {
  toggleBelt: { name: "Start / stop belt", short: "Belt" },
  speedUp: { name: "Faster", short: "Faster" },
  speedDown: { name: "Slower", short: "Slower" },
};

const CAPS_LOCK = 57;

const PHYSICAL_KEY_NAMES: Record<string, string> = { capsLock: "Caps Lock" };

// Keys whose cap names a modifier or a word rather than a character.
const SPECIAL_LABELS: Record<number, string> = {
  36: "Return",
  48: "Tab",
  49: "Space",
  51: "Delete",
  54: "⌘",
  55: "⌘",
  56: "⇧",
  58: "⌥",
  59: "⌃",
  60: "⇧",
  61: "⌥",
  62: "⌃",
  63: "fn",
  [CAPS_LOCK]: "Caps Lock",
};

const CHARACTER_LABEL = /^([A-Z0-9]|[←→↑↓])$/;

// Keyboard geometry in key units (1 = one key pitch). Rows top to bottom as
// [key code, width]; the F-row is left out. Punctuation caps stay blank: their
// labels differ per layout and the sheet doesn't guess them.
const MAIN_BLOCK: [number, number][][] = [
  [
    [50, 1],
    [18, 1],
    [19, 1],
    [20, 1],
    [21, 1],
    [23, 1],
    [22, 1],
    [26, 1],
    [28, 1],
    [25, 1],
    [29, 1],
    [27, 1],
    [24, 1],
    [51, 2],
  ],
  [
    [48, 1.5],
    [12, 1],
    [13, 1],
    [14, 1],
    [15, 1],
    [17, 1],
    [16, 1],
    [32, 1],
    [34, 1],
    [31, 1],
    [35, 1],
    [33, 1],
    [30, 1],
    [42, 1.5],
  ],
  [
    [CAPS_LOCK, 1.75],
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
    [5, 1],
    [4, 1],
    [38, 1],
    [40, 1],
    [37, 1],
    [41, 1],
    [39, 1],
    [36, 2.25],
  ],
  [
    [56, 2.25],
    [6, 1],
    [7, 1],
    [8, 1],
    [9, 1],
    [11, 1],
    [45, 1],
    [46, 1],
    [43, 1],
    [47, 1],
    [44, 1],
    [60, 2.75],
  ],
  [
    [63, 1],
    [59, 1.25],
    [58, 1.25],
    [55, 1.5],
    [49, 6.25],
    [54, 1.5],
    [61, 1.25],
    [62, 1],
  ],
];

// The arrow cluster to the right of the block: [key code, x, y].
const ARROW_CLUSTER: [number, number, number][] = [
  [126, 16.5, 3],
  [123, 15.5, 4],
  [125, 16.5, 4],
  [124, 17.5, 4],
];

export const KEYBOARD_WIDTH = 18.5;
export const KEYBOARD_HEIGHT = 5;

export interface SheetKey {
  keyCode: number;
  label: string; // printed on the cap; "" when the cap is unlabelled
  x: number;
  y: number;
  w: number;
  hyper: boolean; // the Caps Lock cap that is Tinycast's Hyper Key
}

export interface SheetEntry {
  group: SheetGroup;
  keyCode: number;
  cap: string; // the legend's key cap: `Y`, `⇧Y`, `Delete`
  name: string; // legend name
  short: string; // name printed on the key cap
  owner: string; // the app or command the key starts; its initial fills a tile
  icon: string | null; // data URI of a small PNG; null → lettered tile
}

export interface HyperSheet {
  title: string; // "Hyper = Caps Lock (⌃⌥⌘)"
  palette: string | null; // the Tinycast palette's shortcut, e.g. `⌘Space`
  generatedOn: string;
  keyboard: { width: number; height: number; keys: SheetKey[] };
  entries: SheetEntry[]; // legend order: group, then cap
}

export interface HyperSheetInput {
  data: ShortcutsData; // apps include WALKINGPAD_BUNDLE_ID when it is installed
  walkingPad: Record<string, Binding> | null; // null: the WalkingPad domain is missing
  generatedOn: string;
}

function capLabel(keyCode: number, layout: string): string {
  const special = SPECIAL_LABELS[keyCode];
  if (special) return special;
  const label = keyLabel(keyCode, layout);
  return CHARACTER_LABEL.test(label) ? label : "";
}

function keyboardKeys(settings: TinycastSettings, layout: string): SheetKey[] {
  const capsIsHyper = settings.hyperKeyPhysicalKey === "capsLock";
  const key = (keyCode: number, x: number, y: number, w: number): SheetKey => ({
    keyCode,
    label: capLabel(keyCode, layout),
    x,
    y,
    w,
    hyper: capsIsHyper && keyCode === CAPS_LOCK,
  });
  const block = MAIN_BLOCK.flatMap((row, y) => {
    let x = 0;
    return row.map(([keyCode, w]) => {
      const placed = key(keyCode, x, y, w);
      x += w;
      return placed;
    });
  });
  const arrows = ARROW_CLUSTER.map(([keyCode, x, y]) => key(keyCode, x, y, 1));
  return [...block, ...arrows];
}

export function hyperTitle(settings: TinycastSettings): string {
  const glyphs = modifierGlyphs(hyperChord(settings));
  const physical = settings.hyperKeyPhysicalKey;
  if (!physical) return `Hyper = ${glyphs}`;
  return `Hyper = ${PHYSICAL_KEY_NAMES[physical] ?? physical} (${glyphs})`;
}

// Rows of a Hyper section that carry a combo; `Hyper ⇧Y` (a superset chord)
// stays in the legend, a non-Hyper combo such as `⌘1` is left out.
function hyperEntries(
  rows: ShortcutRow[],
  group: SheetGroup,
  iconOf: (icon: RowIcon) => string | null,
): SheetEntry[] {
  return rows.flatMap((row) => {
    if (row.keyCode === null || !row.key?.startsWith("Hyper ")) return [];
    return [
      {
        group,
        keyCode: row.keyCode,
        cap: row.key.slice("Hyper ".length),
        name: row.title,
        short: row.title,
        owner: row.title,
        icon: iconOf(row.icon),
      },
    ];
  });
}

function walkingPadEntries(
  data: ShortcutsData,
  hotkeys: Record<string, Binding>,
  iconOf: (icon: RowIcon) => string | null,
): SheetEntry[] {
  const { settings, layout, apps } = data;
  const hyper = hyperChord(settings);
  const app = apps[WALKINGPAD_BUNDLE_ID];
  const icon = iconOf(
    app?.path ? { kind: "app", path: app.path } : { kind: "fallback" },
  );
  return Object.entries(hotkeys).flatMap(([action, binding]) => {
    if (binding.kind !== "combo") return [];
    const labels = WALKINGPAD_LABELS[action] ?? { name: action, short: action };
    return [
      {
        group: "walkingpad",
        keyCode: binding.keyCode,
        cap: formatBinding(binding, hyper, layout).replace(/^Hyper /, ""),
        name: labels.name,
        short: labels.short,
        owner: app?.name ?? "WalkingPad",
        icon,
      },
    ];
  });
}

export function buildHyperSheet(
  input: HyperSheetInput,
  iconOf: (icon: RowIcon) => string | null,
): HyperSheet {
  const { data, walkingPad, generatedOn } = input;
  const { settings, layout } = data;
  const sections = shortcutSections(data);
  const rowsOf = (title: string) =>
    sections.find((section) => section.title === title)?.rows ?? [];

  const entries = [
    ...hyperEntries(rowsOf(HYPER_APPS), "apps", iconOf),
    ...hyperEntries(rowsOf(HYPER_COMMANDS), "commands", iconOf),
    ...walkingPadEntries(data, walkingPad ?? {}, iconOf),
  ].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      a.cap.localeCompare(b.cap),
  );

  const palette = settings.hotkeys.togglePalette
    ? formatBinding(
        parseBinding(settings.hotkeys.togglePalette),
        hyperChord(settings),
        layout,
      )
    : null;

  return {
    title: hyperTitle(settings),
    palette,
    generatedOn,
    keyboard: {
      width: KEYBOARD_WIDTH,
      height: KEYBOARD_HEIGHT,
      keys: keyboardKeys(settings, layout),
    },
    entries,
  };
}
