// A macOS notification from a background run. No toast or HUD exists there
// (tinycast skill § Preferences, arguments, interval), so the one surface that
// reaches the user is the system's own — via `osascript`, callback-style
// `execFile` like netgear/ping.ts. Never throws: an alert that cannot be shown
// must not fail the run that took the reading.

import { execFile } from "child_process";

const OSASCRIPT_BIN = "/usr/bin/osascript";

// AppleScript string literal: backslash and double quote are the only escapes.
const quoted = (text: string): string =>
  `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function notificationScript(opts: {
  title: string;
  body: string;
}): string {
  return `display notification ${quoted(opts.body)} with title ${quoted(opts.title)}`;
}

// true when osascript accepted it (the user may still have notifications for
// Script Editor switched off — that is a System Settings matter).
export function postNotification(opts: {
  title: string;
  body: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(OSASCRIPT_BIN, ["-e", notificationScript(opts)], (error) =>
        resolve(!error),
      );
    } catch {
      resolve(false);
    }
  });
}
