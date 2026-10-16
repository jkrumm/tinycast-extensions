// Pure formatting for the Shortcuts command. No @raycast/api.

import {
  AppInfo,
  Binding,
  CommandInfo,
  TinycastSettings,
  parseBinding,
} from "./parse";

// Carbon modifier bits
const CMD = 256;
const SHIFT = 512;
const OPTION = 2048;
const CONTROL = 4096;
const ALL_MODIFIERS = CMD | SHIFT | OPTION | CONTROL;
const KARABINER_HYPER = CONTROL | OPTION | SHIFT; // 6656 — Caps Lock via Karabiner

const OWN_EXTENSION = "extension:jkrumm/";

// ANSI Carbon key codes (physical US positions; `keyLabel` applies the layout)
const KEY_LABELS: Record<number, string> = {
  0: "A",
  1: "S",
  2: "D",
  3: "F",
  4: "H",
  5: "G",
  6: "Z",
  7: "X",
  8: "C",
  9: "V",
  11: "B",
  12: "Q",
  13: "W",
  14: "E",
  15: "R",
  16: "Y",
  17: "T",
  18: "1",
  19: "2",
  20: "3",
  21: "4",
  22: "6",
  23: "5",
  24: "=",
  25: "9",
  26: "7",
  27: "-",
  28: "8",
  29: "0",
  30: "]",
  31: "O",
  32: "U",
  33: "[",
  34: "I",
  35: "P",
  36: "Return",
  37: "L",
  38: "J",
  39: "'",
  40: "K",
  41: ";",
  42: "\\",
  43: ",",
  44: "/",
  45: "N",
  46: "M",
  47: ".",
  48: "Tab",
  49: "Space",
  50: "`",
  51: "Delete",
  53: "Escape",
  96: "F5",
  97: "F6",
  98: "F7",
  99: "F3",
  100: "F8",
  101: "F9",
  103: "F11",
  109: "F10",
  111: "F12",
  118: "F4",
  120: "F2",
  122: "F1",
  123: "←",
  124: "→",
  125: "↓",
  126: "↑",
};

const LETTERS = Object.values(KEY_LABELS)
  .filter((label) => /^[A-Z]$/.test(label))
  .sort();

// QWERTZ layouts print Y and Z on each other's physical (US) position. Other
// QWERTZ differences (umlauts, punctuation) don't matter for letter hotkeys.
function swapsYZ(layout: string): boolean {
  return /German|Swiss|Austrian/i.test(layout);
}

export function keyLabel(keyCode: number, layout = ""): string {
  const label = KEY_LABELS[keyCode] ?? `key ${keyCode}`;
  if (!swapsYZ(layout)) return label;
  if (label === "Y") return "Z";
  if (label === "Z") return "Y";
  return label;
}

// The modifier chord that means "Hyper": Tinycast's own Hyper Key (⌃⌥⌘, plus
// ⇧ when it includes shift) when one is configured, else Karabiner's ⌃⌥⇧.
export function hyperChord(settings: TinycastSettings): number {
  if (!settings.hyperKeyPhysicalKey) return KARABINER_HYPER;
  return CONTROL | OPTION | CMD | (settings.hyperKeyIncludesShift ? SHIFT : 0);
}

function modifierGlyphs(modifiers: number): string {
  return (
    (modifiers & CONTROL ? "⌃" : "") +
    (modifiers & OPTION ? "⌥" : "") +
    (modifiers & SHIFT ? "⇧" : "") +
    (modifiers & CMD ? "⌘" : "")
  );
}

// `Hyper Y` for the exact chord, `Hyper ⇧Y` for the chord plus more modifiers.
export function formatBinding(
  binding: Binding,
  hyper: number,
  layout = "",
): string {
  if (binding.kind === "other") return binding.name;
  const key = keyLabel(binding.keyCode, layout);
  const modifiers = binding.modifiers & ALL_MODIFIERS;
  if ((modifiers & hyper) !== hyper) return modifierGlyphs(modifiers) + key;
  return `Hyper ${modifierGlyphs(modifiers & ~hyper)}${key}`;
}

// Letters not bound under exactly the Hyper chord, whatever the action.
export function freeHyperLetters(
  settings: TinycastSettings,
  layout = "",
): string[] {
  const hyper = hyperChord(settings);
  const used = new Set<string>();
  for (const raw of Object.values(settings.hotkeys)) {
    const binding = parseBinding(raw);
    if (binding.kind === "combo" && binding.modifiers === hyper) {
      used.add(keyLabel(binding.keyCode, layout));
    }
  }
  return LETTERS.filter((letter) => !used.has(letter));
}

export function hotkeyCount(settings: TinycastSettings): number {
  return Object.keys(settings.hotkeys).length;
}

export function hubStatus(count: number): string {
  return `${count} ${count === 1 ? "hotkey" : "hotkeys"}`;
}

export interface ShortcutsData {
  settings: TinycastSettings;
  apps: Record<string, AppInfo>; // bundle id → name + .app path
  commands: Record<string, CommandInfo>; // command name → title + icon
  layout: string; // AppleCurrentKeyboardLayoutInputSourceID, "" when unknown
}

// Plain JSON, so it survives useCachedPromise and the component stays thin.
export type RowIcon =
  | { kind: "app"; path: string }
  | { kind: "asset"; file: string }
  | { kind: "fallback" };

export type LaunchTarget =
  { kind: "app"; bundleId: string } | { kind: "command"; name: string };

export interface ShortcutRow {
  id: string;
  title: string;
  key: string | null; // the accessory tag; null = nothing to show
  icon: RowIcon;
  launch: LaunchTarget | null;
  keywords: string[];
}

export interface ShortcutSection {
  title: string;
  subtitle?: string;
  rows: ShortcutRow[];
}

interface Entry {
  title: string;
  icon: RowIcon;
  launch: LaunchTarget | null;
}

// A launcher entry id: `extension:<ext>/<cmd>` or an app bundle id.
function resolveEntry(id: string, data: ShortcutsData): Entry {
  if (id.startsWith(OWN_EXTENSION)) {
    const name = id.slice(OWN_EXTENSION.length);
    const command = data.commands[name];
    return {
      title: command?.title ?? name,
      icon: command?.icon
        ? { kind: "asset", file: command.icon }
        : { kind: "fallback" },
      launch: { kind: "command", name },
    };
  }
  if (id.startsWith("extension:")) {
    return { title: id, icon: { kind: "fallback" }, launch: null };
  }
  const app = data.apps[id];
  return {
    title: app?.name ?? id,
    icon: app?.path ? { kind: "app", path: app.path } : { kind: "fallback" },
    launch: { kind: "app", bundleId: id },
  };
}

function entryRow(
  section: string,
  id: string,
  key: string | null,
  data: ShortcutsData,
): ShortcutRow {
  const entry = resolveEntry(id, data);
  return {
    id: `${section}:${id}`,
    ...entry,
    key,
    keywords: key ? [key, id] : [id],
  };
}

const byKey = (a: ShortcutRow, b: ShortcutRow) =>
  (a.key ?? "").localeCompare(b.key ?? "");

const TOGGLE_PALETTE = "togglePalette";

export function shortcutSections(data: ShortcutsData): ShortcutSection[] {
  const { settings, layout } = data;
  const hyper = hyperChord(settings);
  const apps: ShortcutRow[] = [];
  const commands: ShortcutRow[] = [];
  const tinycast: ShortcutRow[] = [];

  for (const [action, raw] of Object.entries(settings.hotkeys)) {
    const key = formatBinding(parseBinding(raw), hyper, layout);
    if (action.startsWith("app.")) {
      apps.push(entryRow("app", action.slice(4), key, data));
    } else if (action.startsWith(`extensionCommand.${OWN_EXTENSION}`)) {
      commands.push(
        entryRow(
          "command",
          action.slice("extensionCommand.".length),
          key,
          data,
        ),
      );
    } else {
      tinycast.push({
        id: `tinycast:${action}`,
        title: action === TOGGLE_PALETTE ? "Toggle palette" : action,
        key,
        icon: { kind: "fallback" },
        launch: null,
        keywords: [key, action],
      });
    }
  }
  tinycast.sort((a, b) =>
    a.id === `tinycast:${TOGGLE_PALETTE}`
      ? -1
      : b.id === `tinycast:${TOGGLE_PALETTE}`
        ? 1
        : byKey(a, b),
  );

  const aliases = Object.entries(settings.aliases)
    .map(([id, alias]) => entryRow("alias", id, alias, data))
    .sort(byKey);
  const favorites = settings.favorites.map((id, index) =>
    entryRow("favorite", id, index < 10 ? `⌘${(index + 1) % 10}` : null, data),
  );

  const free = freeHyperLetters(settings, layout);
  const sections: ShortcutSection[] = [
    {
      title: "Hyper — Apps",
      subtitle: `free: ${free.length > 0 ? free.join(" ") : "none"}`,
      rows: apps.sort(byKey),
    },
    { title: "Hyper — Commands", rows: commands.sort(byKey) },
    { title: "Tinycast", rows: tinycast },
    { title: "Aliases", rows: aliases },
    { title: "Favorites", rows: favorites },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function shortcutsMarkdown(data: ShortcutsData): string {
  const lines = ["# Shortcuts"];
  for (const section of shortcutSections(data)) {
    lines.push("", `## ${section.title}`);
    if (section.subtitle) lines.push("", `_${section.subtitle}_`);
    lines.push("", "| Key | Name |", "|-|-|");
    for (const row of section.rows) {
      lines.push(`| ${cell(row.key ?? "—")} | ${cell(row.title)} |`);
    }
  }
  return lines.join("\n");
}
