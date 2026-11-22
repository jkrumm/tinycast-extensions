// The impure half of the WalkingPad commands: config from the Mac app's
// storage, a fetch transport with a timeout, and the last reading in
// LocalStorage (stale-while-revalidate for the view, the hub tile).

import { LocalStorage } from "@raycast/api";
import { execFile } from "child_process";
import { PadClient, Transport, WalkingPadError, createClient } from "./client";
import { Exec, HostConfig, readConfig } from "./config";
import { parseStatus } from "./parse";
import { PadStatus } from "./types";

const CACHE_KEY = "walkingpad-status";
const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;

const exec: Exec = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: "utf8", timeout: KEYCHAIN_PROMPT_TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export function fetchTransport(config: HostConfig): Transport {
  return {
    async request({ method, path, body, timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(config.baseUrl + path, {
          method,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${config.token}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.text() };
      } catch {
        // The message of a fetch failure can carry the URL: never forward it.
        if (controller.signal.aborted) {
          throw new WalkingPadError("timeout", "Timed out");
        }
        throw new WalkingPadError("unreachable", "Host unreachable");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface Connection {
  client: PadClient;
  startSpeed: number;
}

export async function connect(): Promise<Connection> {
  const config = await readConfig(exec);
  return {
    client: createClient(fetchTransport(config)),
    startSpeed: config.startSpeed,
  };
}

// ─── Last reading ───────────────────────────────────────────────────────────

export interface CachedStatus {
  status: PadStatus;
  at: number;
}

export async function readCached(): Promise<CachedStatus | null> {
  const raw = await LocalStorage.getItem<string>(CACHE_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const { status, at } = JSON.parse(raw) as { status: unknown; at: unknown };
    const parsed = parseStatus(JSON.stringify(status));
    return parsed && typeof at === "number" ? { status: parsed, at } : null;
  } catch {
    return null;
  }
}

// Stored in the host's own shape, so `parseStatus` reads it back.
export const writeCached = (status: PadStatus, at = Date.now()) =>
  LocalStorage.setItem(
    CACHE_KEY,
    JSON.stringify({
      at,
      status: {
        connected: status.connected,
        belt_state: status.beltState,
        speed_kmh: status.speedKmh ?? undefined,
        current_session: status.session && {
          started_at: status.session.startedAt,
          duration_s: status.session.durationS,
          distance_m: status.session.distanceM,
          steps: status.session.steps,
          kcal: status.session.kcal,
          avg_speed_kmh: status.session.avgSpeedKmh,
          max_speed_kmh: status.session.maxSpeedKmh,
        },
        today: {
          duration_s: status.today.durationS,
          distance_m: status.today.distanceM,
          steps: status.today.steps,
          kcal: status.today.kcal,
        },
        adapter_error: status.adapterError ?? undefined,
      },
    }),
  ).catch(() => undefined);
