// Friendly translations of raw transport/router errors, shared by every
// surface that shows one to a human or logs one for later diagnosis:
// withAdmin's failure toasts (session.ts), watchdog event messages
// (watchdog.ts), and live-actions.ts's console output — so the same failure
// never reads differently in three places. Pure — no `@raycast/api` import.

// curl's own exit codes (transport.ts, internet-probe.ts both shell out to
// it) for "couldn't connect" (7) and "operation timeout" (28), plus the
// Node-level errno strings a failed TCP connect can also surface.
const UNREACHABLE_PATTERNS = [
  /curl exited 7\b/,
  /curl exited 28\b/,
  /couldn't connect/i,
  /could not connect/i,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /EHOSTUNREACH/,
  /ENETUNREACH/,
];

export const ROUTER_UNREACHABLE_MESSAGE =
  "Router not reachable — is this Mac on the router's Wi-Fi?";

// client.ts's `reboot()` after the router refused both spellings of the
// restart value.
const REBOOT_BOTH_REFUSED_PATTERN =
  /^Router rejected the reboot request \(tried both variants/;

// client.ts's `action()` throws `Router rejected the ${label} request: <body>`.
const ROUTER_REJECTED_PATTERN = /^Router rejected the (.+?) request\b/;

// True for the router refusing an action (as opposed to it being unreachable)
// — flows.ts uses it to tolerate a refusal when the router is already in the
// state the action was meant to produce.
export function isRouterRejection(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return ROUTER_REJECTED_PATTERN.test(message);
}

// The router answered, but not with the JSON model the client parses — a
// restarting router serves an HTML page, an empty body, or a redirect.
const UNEXPECTED_PAGE_PATTERNS = [
  /JSON Parse error/i,
  /Unexpected token/,
  /Unexpected end of JSON/i,
  /is not valid JSON/i,
];

// flows.ts: `Timed out waiting to (connect|disconnect) (last state: X).`
const TIMEOUT_PATTERN =
  /Timed out waiting to (connect|disconnect) \(last state: ([^)]*)\)/;

// transport.ts / internet-probe.ts: `curl exited <code>: …` — 7 and 28 are
// already covered by UNREACHABLE_PATTERNS above.
const CURL_EXIT_PATTERN = /curl exited (\d+)\b/;

// A bug in this extension (or the runtime shim), not a router problem.
const INTERNAL_PATTERNS = [
  /\bTypeError\b/,
  /is not a function/,
  /undefined is not an object/,
];

// No instanceof checks against transport-specific error classes — there are
// none (see transport.ts) — this matches the message text every layer
// already throws with. Every output says what happened and what to do; the
// raw text is for the log (`describeErrorDetail`), not the human.
export function describeNetgearError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (UNREACHABLE_PATTERNS.some((p) => p.test(message))) {
    return ROUTER_UNREACHABLE_MESSAGE;
  }
  if (UNEXPECTED_PAGE_PATTERNS.some((p) => p.test(message))) {
    return "Router answered with an unexpected page — it may be restarting. Try again in a minute.";
  }
  const timeout = TIMEOUT_PATTERN.exec(message);
  if (timeout?.[1] === "connect") {
    return `Router did not connect within the time limit (still ${timeout[2]}). Check the SIM has data and the APN is right.`;
  }
  if (timeout) {
    return `Router did not drop the connection in time (still ${timeout[2]}). Try again, or Restart & Reconnect.`;
  }
  if (REBOOT_BOTH_REFUSED_PATTERN.test(message)) {
    return "Router refused the restart (tried both variants) — restart it from the router's website or power button.";
  }
  const rejected = ROUTER_REJECTED_PATTERN.exec(message);
  if (rejected) {
    return `Router refused the ${rejected[1]} request — it may be busy or the session expired. Try again.`;
  }
  const curl = CURL_EXIT_PATTERN.exec(message);
  if (curl) return `Network error talking to the router (curl ${curl[1]}).`;
  if (
    e instanceof TypeError ||
    INTERNAL_PATTERNS.some((p) => p.test(message))
  ) {
    return "Internal extension error — see the Netgear log (make logs).";
  }
  return message;
}

// The raw error for the log's `[raw: …]` column: the message plus the first
// three stack frames (a V8-style stack repeats the message on line one —
// skipped). Pure; `message` is what `describeNetgearError` was given.
export function describeErrorDetail(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const frames = (e.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(e.message))
    .slice(0, 3);
  return [e.message, ...frames].join("\n");
}
