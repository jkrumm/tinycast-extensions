// The only impure part of the Van Power feature: resolve the Victron key and
// spawn the van-ble helper. Tinycast Beta is the TCC-responsible process for
// Bluetooth (it carries NSBluetoothAlwaysUsageDescription and the user's
// grant), so the helper is a bare binary shipped in assets/ — no .app bundle.
//
// `spawn`, not `execFile`: the key goes in via stdin (never argv), and
// Tinycast's child_process shim exposes `stdin` only on a spawned child
// (its callback-style execFile returns a handle without one).

import { spawn } from "child_process";
import { join } from "path";
import { environment, getPreferenceValues } from "@raycast/api";
import { Preferences } from "../lib/preferences";
import { SecretUnavailableError, getSecret } from "../lib/secrets";
import { parseHelperOutput } from "./parse";
import { HelperResult } from "./types";
import { VictronHistory, parseHistoryOutput } from "./victron-history";
import {
  VictronAllResult,
  VictronTrendsResult,
  parseAllOutput,
  parseTrendsOutput,
} from "./victron-trends";

// A missing key must never break the battery read — the view says so instead.
async function resolveVictronKey(): Promise<string | null> {
  try {
    return await getSecret("victronKey", getPreferenceValues<Preferences>());
  } catch (e) {
    if (e instanceof SecretUnavailableError) return null;
    throw e;
  }
}

// The helper enforces its own deadlines and always exits 0 with a JSON line,
// so no timeout is layered on here unless `killAfterMs` is given (a hang guard
// for the long GATT session, not a budget).
function spawnHelper<T>({
  args,
  input,
  parse,
  killAfterMs,
}: {
  args: string[];
  input?: string;
  parse: (stdout: string) => T;
  killAfterMs?: number;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(environment.assetsPath, "van-ble"), args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let guard: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      action();
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (e) => settle(() => reject(e)));
    child.on("close", (code) =>
      settle(() => {
        if (code !== 0) {
          reject(new Error(`van-ble exited ${code}: ${stderr.trim()}`));
          return;
        }
        try {
          resolve(parse(stdout));
        } catch (e) {
          reject(e);
        }
      }),
    );
    if (killAfterMs) {
      guard = setTimeout(
        () =>
          settle(() => {
            child.kill();
            reject(new Error(`van-ble hung for ${killAfterMs} ms`));
          }),
        killAfterMs,
      );
    }
    child.stdin?.end(input);
  });
}

const runHelper = (key: string | null): Promise<HelperResult> =>
  spawnHelper({ args: [], input: key ?? undefined, parse: parseHelperOutput });

export async function readVan(): Promise<{
  helper: HelperResult;
  keyMissing: boolean;
}> {
  const key = await resolveVictronKey();
  return { helper: await runHelper(key), keyMissing: key === null };
}

// Longest legitimate helper run: scan 10 s + connect 15 s + pairing 60 s +
// 45 s of reads; 150 s is only the hang guard.
const VICTRON_HISTORY_KILL_MS = 150_000;

// The Victron's own 30-day daily history over a connected GATT session
// (`van-ble --victron-history`, read-only by the helper's write allowlist).
// Needs no key. Slow (10–45 s, up to ~2 min on the first run while macOS shows
// its pairing dialog) and exclusive — the phone app must not be connected — so
// callers run it on demand, never on every open.
export function runVictronHistory(): Promise<VictronHistory> {
  return spawnHelper({
    args: ["--victron-history"],
    parse: (stdout) => parseHistoryOutput(stdout),
    killAfterMs: VICTRON_HISTORY_KILL_MS,
  });
}

// The Victron's stored trends (72 h of battery V/A, PV V/W at 30 min) over a
// connected GATT session (`van-ble --victron-trends`, ~10 s). The helper sends
// the one extra write VictronConnect itself uses for trends (see AGENTS.md
// Safety); like the history it is exclusive, so callers run it on demand.
export function runVictronTrends(): Promise<VictronTrendsResult> {
  return spawnHelper({
    args: ["--victron-trends"],
    parse: (stdout) => parseTrendsOutput(stdout),
    killAfterMs: VICTRON_HISTORY_KILL_MS,
  });
}

// The daily history and the 72 h trends in ONE connected session
// (`van-ble --victron-all`: one connect, one pairing check, ~20 s). A failed
// part does not lose the other: history ok + trends failed still returns the
// history, with the helper's error codes in `errors`.
const VICTRON_ALL_KILL_MS = 200_000;

export interface VictronAllOptions {
  // Only fetch trend samples newer than this unix-ms instant (minus one step of
  // overlap) — the cached series' last sample time. Merge with `mergeTrends`.
  sinceMs?: number;
  // false skips the daily history (`--skip-history`) when the cached one is
  // fresh; the result's `history` is then empty (`total: null, days: []`).
  history?: boolean;
}

export function runVictronAll({
  sinceMs,
  history = true,
}: VictronAllOptions = {}): Promise<VictronAllResult> {
  const args = ["--victron-all"];
  if (sinceMs !== undefined) args.push("--since", String(Math.floor(sinceMs)));
  if (!history) args.push("--skip-history");
  return spawnHelper({
    args,
    parse: (stdout) => parseAllOutput(stdout),
    killAfterMs: VICTRON_ALL_KILL_MS,
  });
}
