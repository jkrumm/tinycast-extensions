// The one line `scan-cli` prints, read defensively: anything that is not the
// documented JSON becomes a plain failure, never a thrown error.

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

export const COMMAND_FAILED = "Scan command failed";

// The one-line result of `--file` / `--discard`: `{ ok, message }`, the
// message is what the HUD shows either way.
export function parseResultLine(stdout: string): {
  ok: boolean;
  message: string;
} {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  try {
    const value = line ? JSON.parse(line) : null;
    if (
      typeof value?.ok === "boolean" &&
      typeof value.message === "string" &&
      value.message
    ) {
      return { ok: value.ok, message: value.message };
    }
  } catch {
    // fall through
  }
  return { ok: false, message: COMMAND_FAILED };
}
