// Pure formatting for the Shortcuts command. No @raycast/api.

import { Binding, TinycastSettings, parseBinding } from "./parse";

// Carbon modifier bits
const CMD = 256;
const SHIFT = 512;
const OPTION = 2048;
const CONTROL = 4096;
const HYPER = CONTROL | OPTION | SHIFT; // 6656 — Caps Lock via Karabiner

const OWN_EXTENSION = "extension:jkrumm/";

// ANSI Carbon key codes
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

export function keyLabel(keyCode: number): string {
  return KEY_LABELS[keyCode] ?? `key ${keyCode}`;
}

function modifierGlyphs(modifiers: number): string {
  if ((modifiers & HYPER) === HYPER) return modifiers & CMD ? "⇪⌘" : "⇪";
  return (
    (modifiers & CONTROL ? "⌃" : "") +
    (modifiers & OPTION ? "⌥" : "") +
    (modifiers & SHIFT ? "⇧" : "") +
    (modifiers & CMD ? "⌘" : "")
  );
}

export function formatBinding(binding: Binding): string {
  if (binding.kind === "other") return binding.name;
  return modifierGlyphs(binding.modifiers) + keyLabel(binding.keyCode);
}

// Letters not bound under exactly ⌃⌥⇧, whatever the action.
export function freeHyperLetters(settings: TinycastSettings): string[] {
  const used = new Set<string>();
  for (const raw of Object.values(settings.hotkeys)) {
    const binding = parseBinding(raw);
    if (binding.kind === "combo" && binding.modifiers === HYPER) {
      used.add(keyLabel(binding.keyCode));
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
  appNames: Record<string, string>; // bundle id → display name
  commandTitles: Record<string, string>; // command name → title
}

interface Row {
  key: string;
  label: string;
}

const byKey = (a: Row, b: Row) => a.key.localeCompare(b.key);

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function table(headers: [string, string], rows: Row[]): string[] {
  return [
    `| ${headers[0]} | ${headers[1]} |`,
    "|-|-|",
    ...rows.map((row) => `| ${cell(row.key)} | ${cell(row.label)} |`),
  ];
}

function section(title: string, headers: [string, string], rows: Row[]) {
  if (rows.length === 0) return [];
  return ["", `## ${title}`, "", ...table(headers, rows)];
}

// A launcher entry id: `extension:<ext>/<cmd>` or an app bundle id.
function entryLabel(id: string, data: ShortcutsData): string {
  if (id.startsWith(OWN_EXTENSION)) {
    const command = id.slice(OWN_EXTENSION.length);
    return data.commandTitles[command] ?? command;
  }
  return data.appNames[id] ?? id;
}

export function shortcutsMarkdown(data: ShortcutsData): string {
  const { settings } = data;
  const apps: Row[] = [];
  const commands: Row[] = [];
  const tinycast: Row[] = [];

  for (const [action, raw] of Object.entries(settings.hotkeys)) {
    const binding = parseBinding(raw);
    const key = formatBinding(binding);
    if (action === "togglePalette") {
      tinycast.push({ key, label: "Toggle palette" });
    } else if (action.startsWith("app.")) {
      apps.push({ key, label: entryLabel(action.slice(4), data) });
    } else if (action.startsWith(`extensionCommand.${OWN_EXTENSION}`)) {
      commands.push({
        key,
        label: entryLabel(action.slice("extensionCommand.".length), data),
      });
    } else {
      tinycast.push({ key, label: action });
    }
  }
  tinycast.sort((a, b) =>
    a.label === "Toggle palette"
      ? -1
      : b.label === "Toggle palette"
        ? 1
        : byKey(a, b),
  );

  const aliases: Row[] = Object.entries(settings.aliases)
    .map(([id, alias]) => ({ key: alias, label: entryLabel(id, data) }))
    .sort(byKey);
  const favorites: Row[] = settings.favorites.map((id, index) => ({
    key: index < 10 ? `⌘${(index + 1) % 10}` : "—",
    label: entryLabel(id, data),
  }));

  const free = freeHyperLetters(settings);
  const lines = [
    "# Shortcuts",
    "",
    `_⇪ = Caps Lock (Karabiner). Free Hyper letters: ${free.length > 0 ? free.join(" ") : "none"}._`,
    ...section("Hyper ⇪ — apps", ["Key", "App"], apps.sort(byKey)),
    ...section(
      "Hyper ⇪ — extension commands",
      ["Key", "Command"],
      commands.sort(byKey),
    ),
    ...section("Tinycast", ["Key", "Action"], tinycast),
  ];

  if (aliases.length > 0 || favorites.length > 0) {
    lines.push("", "## Launcher");
    if (aliases.length > 0) {
      lines.push(
        "",
        "### Aliases",
        "",
        ...table(["Alias", "Command"], aliases),
      );
    }
    if (favorites.length > 0) {
      lines.push(
        "",
        "### Favorites (empty query)",
        "",
        ...table(["Key", "Command / App"], favorites),
      );
    }
  }
  return lines.join("\n");
}
