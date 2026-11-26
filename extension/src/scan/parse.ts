// The one line `scan-cli --check` prints, read defensively: anything that is
// not the documented JSON becomes a plain failure, never a thrown error.

import { CheckResult } from "./runner";

export const CHECK_FAILED: CheckResult = {
  ok: false,
  message: "Scan check failed",
};

export function parseCheckLine(stdout: string): CheckResult {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) return CHECK_FAILED;
  try {
    const value = JSON.parse(line);
    if (value?.ok === true) return { ok: true };
    if (
      value?.ok === false &&
      typeof value.message === "string" &&
      value.message
    ) {
      return { ok: false, message: value.message };
    }
  } catch {
    // fall through
  }
  return CHECK_FAILED;
}
