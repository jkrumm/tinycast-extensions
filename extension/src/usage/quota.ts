import { readFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { argoFetch } from "../lib/argo";
import {
  OverviewResponse,
  STALE_HINT_SECONDS,
  accountsFromOverview,
  primaryQuota,
} from "./accounts";

export { STALE_HINT_SECONDS };
import { UsageQuota } from "./types";

const execFileAsync = promisify(execFile);

const USAGE_FILE = "/tmp/claude_sl/usage_api.json";
// Below the menu bar's 2m interval, so every scheduled run refetches; the
// fetcher's own 429 handling keeps the last file when rate-limited.
const REFETCH_AFTER_SECONDS = 100;
// fetch_usage.py's HTTP timeout is 10 s; never let a hung `uv` hold a menu-bar
// run past Tinycast's 60 s deadline (a timed-out run keeps the old title).
const FETCH_TIMEOUT_MS = 20_000;

const ARGO_TIMEOUT_MS = 5_000;
// An Argo reading whose newest account is older than this is as good as a
// failed fetch (the push stopped) — the local file is fresher.
const ARGO_MAX_AGE_SECONDS = 30 * 60;

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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Primary source: agent-gateway's overview, pushed to Argo (agent-gateway
// itself is loopback-only). Null on any failure or while the payload has no
// `quota` yet.
async function getArgoQuota(): Promise<UsageQuota | null> {
  try {
    const overview = await withTimeout(
      argoFetch<OverviewResponse>("/agents/overview"),
      ARGO_TIMEOUT_MS,
    );
    const accounts = accountsFromOverview(overview);
    if (!accounts) return null;
    const newest = Math.max(...accounts.map((a) => a.updatedAt));
    if (Date.now() / 1000 - newest > ARGO_MAX_AGE_SECONDS) return null;
    const local = await readQuotaFile();
    return primaryQuota(accounts, local && !("error" in local) ? local : null);
  } catch {
    return null;
  }
}

// Fallback: the statusline's rate-limit-aware fetcher, single account — never
// call api.anthropic.com directly.
async function getLocalQuota(): Promise<UsageQuota> {
  let quota = await readQuotaFile();
  if (isStale(quota)) {
    try {
      await execFileAsync(FETCH_BIN, FETCH_ARGS, { timeout: FETCH_TIMEOUT_MS });
    } catch {
      // Ignore — fall back to whatever is already on disk.
    }
    quota = await readQuotaFile();
  }
  if (!quota) {
    return {
      error:
        "No Claude quota data — run `claude` once on this Mac to log in, then refresh.",
      fetched_at: 0,
    };
  }
  if ("error" in quota) return quota;
  return {
    ...quota,
    accounts: [
      {
        id: "iu (local)",
        plan: null,
        fiveHourPct: quota.five_hour.utilization,
        sevenDayPct: quota.seven_day.utilization,
        fiveHourResetsAt: quota.five_hour.resets_at_epoch,
        sevenDayResetsAt: quota.seven_day.resets_at_epoch,
        authOk: true,
        exhaustedUntil: null,
        updatedAt: quota.fetched_at,
      },
    ],
  };
}

export async function getQuota(): Promise<UsageQuota> {
  return (await getArgoQuota()) ?? (await getLocalQuota());
}

export function isStaleHint(fetchedAt: number): boolean {
  const now = Date.now() / 1000;
  return now - fetchedAt > STALE_HINT_SECONDS;
}
