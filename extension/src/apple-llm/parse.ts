// Pure: the apple-llm helper's one-line JSON reply → results or a friendly error.

export type LlmReply =
  | { ok: true; results: string[] }
  | { ok: false; available: boolean; error: string };

export function parseLlmReply(stdout: string): LlmReply {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line)
    return { ok: false, available: true, error: "apple-llm printed nothing" };
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      available: true,
      error: "apple-llm printed an unexpected value",
    };
  }
  const r = raw as {
    ok?: boolean;
    available?: boolean;
    results?: unknown;
    error?: string;
  };
  if (
    r.ok &&
    Array.isArray(r.results) &&
    r.results.every((x) => typeof x === "string")
  ) {
    return { ok: true, results: r.results as string[] };
  }
  return {
    ok: false,
    available: r.available !== false,
    error: r.error ?? "apple-llm failed",
  };
}

export function describeLlmError(
  reply: Extract<LlmReply, { ok: false }>,
): string {
  if (reply.available) return reply.error;
  if (reply.error.includes("appleIntelligenceNotEnabled")) {
    return "Apple Intelligence is off — enable it in System Settings.";
  }
  if (reply.error.includes("modelNotReady")) {
    return "Apple Intelligence model is still downloading — try again later.";
  }
  return `On-device model unavailable (${reply.error}).`;
}
