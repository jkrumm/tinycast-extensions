import { readFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { UsageQuota } from "./types";

const execFileAsync = promisify(execFile);

const USAGE_FILE = "/tmp/claude_sl/usage_api.json";
const REFETCH_AFTER_SECONDS = 300;
export const STALE_HINT_SECONDS = 15 * 60;

const FETCH_BIN = "/opt/homebrew/bin/uv";
const FETCH_ARGS = ["run", `${homedir()}/.claude/fetch_usage.py`];

async function readQuotaFile(): Promise<UsageQuota | null> {
  try {
    const raw = await readFile(USAGE_FILE, "utf8");
    return JSON.parse(raw) as UsageQuota;
  } catch {
    return null;
  }
}

function isStale(quota: UsageQuota | null): boolean {
  if (!quota) return true;
  const now = Date.now() / 1000;
  return now - quota.fetched_at > REFETCH_AFTER_SECONDS;
}

// The statusline uses the same rate-limit-aware fetcher — never call
// api.anthropic.com directly from here.
export async function getQuota(): Promise<UsageQuota> {
  let quota = await readQuotaFile();
  if (isStale(quota)) {
    try {
      await execFileAsync(FETCH_BIN, FETCH_ARGS);
    } catch {
      // Ignore — fall back to whatever is already on disk.
    }
    quota = await readQuotaFile();
  }
  if (!quota) {
    return {
      error: "No usage data on disk — check claude.ai login",
      fetched_at: 0,
    };
  }
  return quota;
}

export function isStaleHint(fetchedAt: number): boolean {
  const now = Date.now() / 1000;
  return now - fetchedAt > STALE_HINT_SECONDS;
}
