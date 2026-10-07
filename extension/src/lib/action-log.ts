// Persistent, human-readable action log. `console.log` is compiled out of
// Tinycast's release build, so a file under the extension's support dir is the
// only log surface an agent or the user can read afterwards (`make logs`,
// `make status`, the "Show Netgear Log" action). One line per entry:
//
//   2026-10-02 11:30:01  ui        Reconnect           failed   <message>  [raw: …]
//
// Pure fs, no `@raycast/api`, and only fs functions Tinycast's node shim
// implements (enforced by tinycast-runtime.test.ts). Logging never throws —
// a broken log must not break the action it describes.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
} from "fs";

export const LOG_MAX_BYTES = 512 * 1024;
const DETAIL_MAX_CHARS = 600;
const NEWLINE_MARK = " ⏎ ";

export interface LogEntry {
  source: string;
  action: string;
  outcome: string;
  message: string;
  detail?: string;
}

export interface AppendLogLineOptions extends LogEntry {
  path: string;
  now?: Date;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function localTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function oneLine(text: string): string {
  return text.trim().replace(/\r?\n/g, NEWLINE_MARK);
}

export function formatLogLine(
  opts: Omit<AppendLogLineOptions, "path">,
): string {
  const { source, action, outcome, message, detail, now = new Date() } = opts;
  const head = [
    localTimestamp(now),
    source.padEnd(8),
    action.padEnd(18),
    outcome.padEnd(7),
  ].join("  ");
  const text = oneLine(message);
  const raw = detail === undefined ? "" : oneLine(detail);
  if (!raw || raw === text) return `${head}  ${text}`.trimEnd();
  const clipped =
    raw.length > DETAIL_MAX_CHARS ? `${raw.slice(0, DETAIL_MAX_CHARS)}…` : raw;
  return `${head}  ${text}  [raw: ${clipped}]`;
}

export function appendLogLine(opts: AppendLogLineOptions): void {
  try {
    const { path, ...entry } = opts;
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, `${formatLogLine(entry)}\n`);
  } catch {
    // Deliberately swallowed — see the header.
  }
}

export function readLogTail(path: string, lines: number): string[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-lines);
  } catch {
    return [];
  }
}
