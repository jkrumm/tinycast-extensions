import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join } from "path";
import { environment } from "@raycast/api";
import { ShortcutsData } from "./format";
import {
  TinycastSettings,
  parseAppIndex,
  parseCommandTitles,
  parseTinycastSettings,
} from "./parse";

const execFileAsync = promisify(execFile);

const DEFAULTS_BIN = "/usr/bin/defaults";
const TINYCAST_DOMAIN = "com.tinycast.app.beta";

export async function readTinycastSettings(): Promise<TinycastSettings> {
  const { stdout } = await execFileAsync(DEFAULTS_BIN, [
    "export",
    TINYCAST_DOMAIN,
    "-",
  ]);
  return parseTinycastSettings(stdout);
}

export async function loadHotkeyCount(): Promise<number> {
  const settings = await readTinycastSettings();
  return Object.keys(settings.hotkeys).length;
}

// bundle id → app name, from every .app's Info.plist in the usual folders. One
// shell for all of them: Spotlight (`mdfind`) is disabled on this Mac.
const APP_INDEX_SCRIPT = `
for a in /Applications/*.app /Applications/Utilities/*.app /System/Applications/*.app \
  "$HOME"/Applications/*.app "$HOME"/Applications/*/*.app; do
  [ -f "$a/Contents/Info.plist" ] || continue
  id=$(/usr/bin/plutil -extract CFBundleIdentifier raw "$a/Contents/Info.plist" 2>/dev/null) || continue
  printf '%s\\t%s\\n' "$id" "$(basename "$a" .app)"
done`;

async function appNames(): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", APP_INDEX_SCRIPT]);
    return parseAppIndex(stdout);
  } catch {
    return {};
  }
}

async function commandTitles(): Promise<Record<string, string>> {
  try {
    const manifest = await readFile(
      join(environment.assetsPath, "..", "package.json"),
      "utf8",
    );
    return parseCommandTitles(manifest);
  } catch {
    return {};
  }
}

export async function loadShortcuts(): Promise<ShortcutsData> {
  const settings = await readTinycastSettings();
  const bundleIds = new Set(
    [
      ...Object.keys(settings.hotkeys)
        .filter((action) => action.startsWith("app."))
        .map((action) => action.slice(4)),
      ...settings.favorites,
      ...Object.keys(settings.aliases),
    ].filter((id) => !id.startsWith("extension:")),
  );
  const [titles, index] = await Promise.all([commandTitles(), appNames()]);
  return {
    settings,
    appNames: Object.fromEntries(
      [...bundleIds].map((id) => [id, index[id] ?? id]),
    ),
    commandTitles: titles,
  };
}
