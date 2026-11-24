// The Mac reads behind the Shortcuts command and `make hyper-sheet`: a defaults
// domain, the keyboard layout, the installed apps. No @raycast/api, so the bun
// script can import it too.

import { execFile } from "child_process";
import { promisify } from "util";
import { AppInfo, parseAppIndex } from "./parse";

const execFileAsync = promisify(execFile);

const DEFAULTS_BIN = "/usr/bin/defaults";

// `defaults export <domain> -` as XML; rejects when the domain doesn't exist.
export async function exportDomain(domain: string): Promise<string> {
  const { stdout } = await execFileAsync(DEFAULTS_BIN, ["export", domain, "-"]);
  return stdout;
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

export async function appIndex(): Promise<Record<string, AppInfo>> {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", APP_INDEX_SCRIPT]);
    return parseAppIndex(stdout);
  } catch {
    return {};
  }
}

// e.g. `com.apple.keylayout.German`; "" when it can't be read.
export async function keyboardLayout(): Promise<string> {
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
