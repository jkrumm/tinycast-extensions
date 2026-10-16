import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join } from "path";
import { LaunchType, environment, launchCommand } from "@raycast/api";
import { LaunchTarget, ShortcutsData } from "./format";
import {
  AppInfo,
  CommandInfo,
  TinycastSettings,
  parseAppIndex,
  parseCommands,
  parseTinycastSettings,
} from "./parse";

const execFileAsync = promisify(execFile);

const DEFAULTS_BIN = "/usr/bin/defaults";
const OPEN_BIN = "/usr/bin/open";
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

// bundle id → app name + path, from every .app's Info.plist in the usual folders. One
// shell for all of them: Spotlight (`mdfind`) is disabled on this Mac.
const APP_INDEX_SCRIPT = `
for a in /Applications/*.app /Applications/Utilities/*.app /System/Applications/*.app \
  "$HOME"/Applications/*.app "$HOME"/Applications/*/*.app; do
  [ -f "$a/Contents/Info.plist" ] || continue
  id=$(/usr/bin/plutil -extract CFBundleIdentifier raw "$a/Contents/Info.plist" 2>/dev/null) || continue
  printf '%s\\t%s\\t%s\\n' "$id" "$(basename "$a" .app)" "$a"
done`;

async function appIndex(): Promise<Record<string, AppInfo>> {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", APP_INDEX_SCRIPT]);
    return parseAppIndex(stdout);
  } catch {
    return {};
  }
}

async function commandInfo(): Promise<Record<string, CommandInfo>> {
  try {
    const manifest = await readFile(
      join(environment.assetsPath, "..", "package.json"),
      "utf8",
    );
    return parseCommands(manifest);
  } catch {
    return {};
  }
}

// e.g. `com.apple.keylayout.German`; "" when it can't be read.
async function keyboardLayout(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(DEFAULTS_BIN, [
      "read",
      "com.apple.HIToolbox",
      "AppleCurrentKeyboardLayoutInputSourceID",
    ]);
    return stdout.trim();
  } catch {
    return "";
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
  const [commands, index, layout] = await Promise.all([
    commandInfo(),
    appIndex(),
    keyboardLayout(),
  ]);
  return {
    settings,
    apps: Object.fromEntries(
      [...bundleIds].flatMap((id) => (index[id] ? [[id, index[id]]] : [])),
    ),
    commands,
    layout,
  };
}

export async function launchTarget(target: LaunchTarget): Promise<void> {
  if (target.kind === "command") {
    await launchCommand({
      name: target.name,
      type: LaunchType.UserInitiated,
    });
    return;
  }
  await execFileAsync(OPEN_BIN, ["-b", target.bundleId]);
}
