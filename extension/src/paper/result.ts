// What paper prints, read back defensively. Pure. Every verb prints one JSON
// line: `ok` and, on the verbs the commands call, a `message`.

export interface PaperResult {
  ok: boolean;
  message: string;
}

export const PAPER_SILENT = "paper did not answer";

export function parseJsonLine(stdout: string): Record<string, unknown> | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// `{ok, message}`; anything else is a failure, never a thrown error.
export function parseResult(stdout: string): PaperResult {
  const value = parseJsonLine(stdout);
  if (typeof value?.ok === "boolean" && typeof value.message === "string") {
    return { ok: value.ok, message: value.message };
  }
  return { ok: false, message: PAPER_SILENT };
}
