// `scan.log` in the state dir: one timestamped line per event, rotated to
// `scan.log.1` at 512 KB. Logging never throws.

import { appendFileSync, existsSync, renameSync, statSync } from "fs";
import { LOG_MAX_BYTES } from "../lib/action-log";

export function appendScanLog(path: string, line: string, now: Date): void {
  try {
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(
      path,
      `${now.toISOString()}  ${line.replace(/\r?\n/g, " ⏎ ")}\n`,
    );
  } catch {
    // A broken log must not break the scan it describes.
  }
}
