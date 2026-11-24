import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join } from "path";
import { LaunchType, environment, launchCommand } from "@raycast/api";
import { LaunchTarget, ShortcutsData } from "./format";
import {
  CommandInfo,
  TinycastSettings,
  parseCommands,
  parseTinycastSettings,
} from "./parse";
import { appIndex, exportDomain, keyboardLayout } from "./system";

const execFileAsync = promisify(execFile);

const OPEN_BIN = "/usr/bin/open";
const TINYCAST_DOMAIN = "com.abueammar.tinycast";

export async function readTinycastSettings(): Promise<TinycastSettings> {
  return parseTinycastSettings(await exportDomain(TINYCAST_DOMAIN));
}

export async function loadHotkeyCount(): Promise<number> {
  const settings = await readTinycastSettings();
  return Object.keys(settings.hotkeys).length;
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
