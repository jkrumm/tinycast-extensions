// Golden responses copied from walkingpad-mac contracts/fixtures (the host's
// own contract tests produce them), loaded as raw JSON text for tests.

import { readFileSync } from "fs";
import { join } from "path";

export type FixtureName =
  | "status-active"
  | "status-standby"
  | "status-stopped"
  | "status-starting"
  | "status-stopping"
  | "status-disconnected"
  | "status-unknown"
  | "status-current-session"
  | "error-unavailable"
  | "ok";

export const fixture = (name: FixtureName): string =>
  readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8");

// A status fixture with fields overridden (e.g. the speed at a range end).
export const statusWith = (
  name: FixtureName,
  patch: Record<string, unknown>,
): string => JSON.stringify({ ...JSON.parse(fixture(name)), ...patch });
