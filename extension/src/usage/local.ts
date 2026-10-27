// This Mac's side of the routing view: `claude-account` (dotfiles' picker, a
// Bun script) is the only owner of the per-account quota cache, so the
// extension asks it instead of reading the cache — and never refreshes it
// (`pick --dry` neither refreshes nor writes a pick-log line).

import { execFile } from "child_process";
import { homedir } from "os";
import { AccountQuota } from "./types";
import { LANES, LanePick, parseLocalUsage, parsePickOutput } from "./routing";

const BIN = `${homedir()}/.local/bin/claude-account`;
// The script's shebang is `env bun`; Tinycast's environment has no Homebrew.
export const PATH = `/opt/homebrew/bin:${homedir()}/.local/bin:/usr/bin:/bin`;
const TIMEOUT_MS = 8_000;

// Port: resolves with stdout even when the command exits non-zero (a bulk
// pick with no room exits 3 and still prints its `# picked=` line); rejects
// only when nothing came back (missing binary, timeout).
export type RunClaudeAccount = (args: string[]) => Promise<string>;

export const claudeAccountRunner =
  (timeoutMs: number): RunClaudeAccount =>
  (args) =>
    new Promise((resolve, reject) => {
      execFile(
        BIN,
        args,
        { timeout: timeoutMs, env: { ...process.env, PATH } },
        (error, stdout) => {
          if (stdout) resolve(stdout);
          else reject(error ?? new Error("no output"));
        },
      );
    });

export const runClaudeAccount = claudeAccountRunner(TIMEOUT_MS);

export interface LocalRouting {
  accounts: AccountQuota[] | null;
  picks: LanePick[] | null;
}

// Null when `claude-account` is unavailable; picks null when none parsed.
export async function loadLocalRouting(
  run: RunClaudeAccount = runClaudeAccount,
  nowSeconds = Date.now() / 1000,
): Promise<LocalRouting | null> {
  const [usage, ...picks] = await Promise.allSettled([
    run(["usage", "--json"]),
    ...LANES.map((lane) =>
      run(["pick", "--lane", lane, "--dry", "--why"]).then((out) =>
        parsePickOutput(lane, out),
      ),
    ),
  ]);
  const accounts =
    usage.status === "fulfilled"
      ? parseLocalUsage(usage.value, nowSeconds)
      : null;
  const parsed = picks.flatMap((p) =>
    p.status === "fulfilled" && p.value ? [p.value] : [],
  );
  if (!accounts && parsed.length === 0) return null;
  return { accounts, picks: parsed.length > 0 ? parsed : null };
}
