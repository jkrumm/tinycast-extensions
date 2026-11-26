// Where the scan state lives (`~/.local/state/scan`, `SCAN_STATE_DIR` overrides):
// shared by the CLI and the Scanner view (which opens `scan.log`). Pure.

import { join } from "path";

export const stateDirOf = (
  env: Record<string, string | undefined>,
  home: string,
): string => env.SCAN_STATE_DIR || join(home, ".local/state/scan");
