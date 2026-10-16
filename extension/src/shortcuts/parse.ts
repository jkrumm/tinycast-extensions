// Pure parsing for the Shortcuts command: Tinycast's defaults domain (an XML
// plist) → the hotkeys, launcher aliases and favorites in it. `plutil -convert
// json` is no option: the domain also holds <data>/<date> values it rejects.

export type PlistValue =
  string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

export interface TinycastSettings {
  // `hotkey.<action>` keys, prefix stripped → the raw JSON binding string.
  hotkeys: Record<string, string>;
  // `extension:<ext>/<cmd>` → alias
  aliases: Record<string, string>;
  // Launcher favorites in order: app bundle ids or `extension:<ext>/<cmd>`.
  favorites: string[];
  // Tinycast's own Hyper Key: the physical key it remaps (`capsLock`, …), null
  // when unset or "none" — then Hyper is Karabiner's ⌃⌥⇧ — and whether it adds ⇧.
  hyperKeyPhysicalKey: string | null;
  hyperKeyIncludesShift: boolean;
}

export type Binding =
  | { kind: "combo"; modifiers: number; keyCode: number }
  | { kind: "other"; name: string };

const TAG = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g;

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
}

function nextTag(xml: string, from: number): Tag | null {
  TAG.lastIndex = from;
  const match = TAG.exec(xml);
  if (!match) return null;
  return {
    name: match[2],
    closing: match[1] === "/",
    selfClosing: match[3] === "/",
    end: TAG.lastIndex,
  };
}

function unescapeXml(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi,
    (_, entity: string) => {
      switch (entity.toLowerCase()) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "amp":
          return "&";
      }
      const code =
        entity[1].toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    },
  );
}

function parseElement(
  xml: string,
  tag: Tag,
): { value: PlistValue; end: number } {
  switch (tag.name) {
    case "true":
      return { value: true, end: tag.end };
    case "false":
      return { value: false, end: tag.end };
    case "array":
    case "dict":
      return parseContainer(xml, tag);
  }
  // Every other element is a leaf with text content.
  if (tag.selfClosing) return { value: "", end: tag.end };
  const closeTag = `</${tag.name}>`;
  const close = xml.indexOf(closeTag, tag.end);
  if (close < 0) throw new Error(`Unterminated <${tag.name}> in plist`);
  const text = xml.slice(tag.end, close);
  const value =
    tag.name === "integer" || tag.name === "real"
      ? Number(text.trim())
      : unescapeXml(text);
  return { value, end: close + closeTag.length };
}

function parseContainer(
  xml: string,
  open: Tag,
): { value: PlistValue; end: number } {
  const isDict = open.name === "dict";
  const array: PlistValue[] = [];
  const dict: { [key: string]: PlistValue } = {};
  if (open.selfClosing) return { value: isDict ? dict : array, end: open.end };

  let pos = open.end;
  for (;;) {
    const child = nextTag(xml, pos);
    if (!child) throw new Error(`Unterminated <${open.name}> in plist`);
    if (child.closing) {
      return { value: isDict ? dict : array, end: child.end };
    }
    if (!isDict) {
      const item = parseElement(xml, child);
      array.push(item.value);
      pos = item.end;
      continue;
    }
    const key = parseElement(xml, child);
    const valueTag = nextTag(xml, key.end);
    if (child.name !== "key" || !valueTag || valueTag.closing) {
      throw new Error("Unexpected plist dict structure");
    }
    const value = parseElement(xml, valueTag);
    dict[String(key.value)] = value.value;
    pos = value.end;
  }
}

function parsePlist(xml: string): PlistValue {
  let pos = 0;
  for (;;) {
    const tag = nextTag(xml, pos);
    if (!tag) throw new Error("No root element in plist");
    if (tag.name === "dict" || tag.name === "array") {
      return parseElement(xml, tag).value;
    }
    pos = tag.end;
  }
}

const HOTKEY_PREFIX = "hotkey.";

function isDict(value: PlistValue | undefined): value is {
  [key: string]: PlistValue;
} {
  return typeof value === "object" && !Array.isArray(value);
}

export function parseTinycastSettings(xml: string): TinycastSettings {
  const root = parsePlist(xml);
  const settings: TinycastSettings = {
    hotkeys: {},
    aliases: {},
    favorites: [],
    hyperKeyPhysicalKey: null,
    hyperKeyIncludesShift: false,
  };
  if (!isDict(root)) return settings;

  const physicalKey = root.hyperKeyPhysicalKey;
  if (
    typeof physicalKey === "string" &&
    physicalKey &&
    physicalKey !== "none"
  ) {
    settings.hyperKeyPhysicalKey = physicalKey;
  }
  settings.hyperKeyIncludesShift = root.hyperKeyIncludesShift === true;

  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith(HOTKEY_PREFIX) && typeof value === "string") {
      settings.hotkeys[key.slice(HOTKEY_PREFIX.length)] = value;
    }
  }
  const aliases = root.launcherAliases;
  if (isDict(aliases)) {
    for (const [id, alias] of Object.entries(aliases)) {
      if (typeof alias === "string") settings.aliases[id] = alias;
    }
  }
  const favorites = root.favoriteApps;
  if (Array.isArray(favorites)) {
    settings.favorites = favorites.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return settings;
}

// `{"combo":{"_0":{"carbonModifiers":6656,"carbonKeyCode":17}}}`; every other
// binding kind (doubleTap, modifier, globe, …) is reported by its kind name.
export function parseBinding(raw: string): Binding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "other", name: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "other", name: "unknown" };
  }
  const [name] = Object.keys(parsed);
  if (!name) return { kind: "other", name: "unknown" };
  if (name !== "combo") return { kind: "other", name };

  const inner = (parsed as { combo?: { _0?: Record<string, unknown> } }).combo
    ?._0;
  const modifiers = inner?.carbonModifiers;
  const keyCode = inner?.carbonKeyCode;
  if (typeof modifiers !== "number" || typeof keyCode !== "number") {
    return { kind: "other", name };
  }
  return { kind: "combo", modifiers, keyCode };
}

export interface CommandInfo {
  title: string;
  icon?: string; // asset file name from the manifest, e.g. `tasks.png`
}

// This extension's command name → title and icon, from the installed manifest.
export function parseCommands(
  manifestJson: string,
): Record<string, CommandInfo> {
  const commands: Record<string, CommandInfo> = {};
  try {
    const manifest = JSON.parse(manifestJson) as {
      commands?: { name?: unknown; title?: unknown; icon?: unknown }[];
    };
    for (const command of manifest.commands ?? []) {
      if (
        typeof command.name === "string" &&
        typeof command.title === "string"
      ) {
        commands[command.name] = {
          title: command.title,
          ...(typeof command.icon === "string" ? { icon: command.icon } : {}),
        };
      }
    }
  } catch {
    // an unreadable manifest just means the names are shown raw
  }
  return commands;
}

export interface AppInfo {
  name: string;
  path?: string; // the .app bundle, for `{ fileIcon }`
}

// `<bundle id>\t<app name>\t<.app path>` lines; the first app found for an id wins.
export function parseAppIndex(stdout: string): Record<string, AppInfo> {
  const apps: Record<string, AppInfo> = {};
  for (const line of stdout.split("\n")) {
    const [id, name, path] = line.split("\t");
    if (id && name && !(id in apps))
      apps[id] = path ? { name, path } : { name };
  }
  return apps;
}
