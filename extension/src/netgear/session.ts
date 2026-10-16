// Shared session plumbing for the Netgear command (`netgear.tsx` and its
// split-out forms): building an authenticated `NetgearClient`,
// resolving the admin password, and running one admin-gated action behind a
// single toast lifecycle. Imports `@raycast/api` (`environment`, toasts), so
// — unlike `flows.ts`/`watchdog.ts` — this file is not resolvable under
// vitest; nothing here needs a unit test, it's a thin assembly of
// already-tested pieces (`transport.ts`, `client.ts`, `lib/secrets.ts`).

import { existsSync, mkdirSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import {
  environment,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { prefs } from "../lib/argo";
import { getSecret, SecretUnavailableError } from "../lib/secrets";
import { CurlNetgearHttp } from "./transport";
import { NetgearClient } from "./client";
import {
  DEFAULT_HOST,
  pinStore,
  wifiCredsStore,
  wifiRejoiner,
} from "./adapters";
import { captureWifiCredentials } from "./wifi-creds-store";
import { ensureRouterReachable } from "./flows";
import { describeErrorDetail, describeNetgearError } from "./errors";
import { appendLogLine, LogEntry } from "../lib/action-log";

export { DEFAULT_HOST, pinStore, wifiCredsStore, wifiRejoiner };

export async function getClient(): Promise<NetgearClient> {
  await mkdir(environment.supportPath, { recursive: true });
  const jarPath = join(environment.supportPath, "netgear-cookies.jar");
  const host = prefs().netgearHost?.replace(/\/$/, "") || DEFAULT_HOST;
  return new NetgearClient({ host, transport: new CurlNetgearHttp(jarPath) });
}

// Resolves the admin password. `toast: false` (background loads, auto-unlock)
// treats an unconfigured password as a normal state and returns null
// quietly, rethrowing anything else. `toast: true` (a user-triggered action)
// instead reports every failure via a toast with a link to Preferences and
// returns null.
export async function getPassword(opts: {
  toast: boolean;
}): Promise<string | null> {
  try {
    return await getSecret("netgearPassword", prefs());
  } catch (e) {
    if (!opts.toast) {
      if (e instanceof SecretUnavailableError) return null;
      throw e;
    }
    await showToast({
      style: Toast.Style.Failure,
      title: "No admin password available",
      message: e instanceof Error ? e.message : String(e),
      primaryAction: {
        title: "Open Preferences",
        onAction: () => openExtensionPreferences(),
      },
    });
    return null;
  }
}

// Persistent action log (lib/action-log.ts) — `console.log` is dead in
// Tinycast's release build, so this file is the only readable record of what a
// Netgear action actually did. On disk:
// ~/Library/Application Support/com.tinycast.app.beta/extension-support/jkrumm/netgear.log
export function netgearLogPath(): string {
  return join(environment.supportPath, "netgear.log");
}

// Never throws — see appendLogLine.
export function logNetgear(entry: LogEntry): void {
  try {
    if (!existsSync(environment.supportPath)) {
      mkdirSync(environment.supportPath, { recursive: true });
    }
  } catch {
    return;
  }
  appendLogLine({ path: netgearLogPath(), ...entry });
}

export type OnProgress = (message: string) => void;

export type AdminFn = (
  client: NetgearClient,
  onProgress: OnProgress,
  password: string,
) => Promise<void>;

export interface WithAdminOptions {
  successTitle?: string;
  // Return true to mark the error handled (the generic failure toast is
  // skipped) — e.g. to hide the toast and push a form instead.
  onError?: (error: unknown, toast: Toast) => boolean;
  // Runs `ensureRouterReachable` (rejoin the Mac to the router's own Wi-Fi
  // with previously-seen credentials, if any) before logging in — only for
  // actions meant to work themselves out of "off the router's Wi-Fi":
  // Reconnect, Restart & Reconnect, Enter/Unblock SIM PIN. Every other admin
  // action stays a plain (friendly) failure when the router isn't reachable.
  selfHeal?: boolean;
}

// The one shape every admin-gated Netgear action follows: resolve the
// password (toasting if missing) → animated toast → authenticated client →
// run `fn`, which reports progress back onto the same toast → success or
// failure toast. Replaces what used to be ~12 copy-pasted
// password+client+login blocks across netgear.tsx.
export async function withAdmin(
  label: string,
  fn: AdminFn,
  opts: WithAdminOptions = {},
): Promise<void> {
  const password = await getPassword({ toast: true });
  if (!password) return;

  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `${label}…`,
  });
  const onProgress: OnProgress = (message) => {
    toast.message = message;
    logNetgear({ source: "ui", action: label, outcome: "step", message });
  };
  logNetgear({ source: "ui", action: label, outcome: "start", message: "" });
  try {
    const client = await getClient();
    if (opts.selfHeal) {
      await ensureRouterReachable({
        client,
        wifi: wifiRejoiner,
        credsStore: wifiCredsStore,
        onProgress,
      });
    }
    await client.login(password);
    // Best-effort, on every successful admin login — not just the
    // self-healing actions — so the Mac learns the router's Wi-Fi as soon
    // as any Admin session sees it, well before it's ever needed.
    await captureWifiCredentials({ client, store: wifiCredsStore });
    await fn(client, onProgress, password);
    toast.style = Toast.Style.Success;
    toast.title = opts.successTitle ?? `${label} done`;
    logNetgear({
      source: "ui",
      action: label,
      outcome: "ok",
      message: toast.title,
    });
  } catch (e) {
    logNetgear({
      source: "ui",
      action: label,
      outcome: "failed",
      message: describeNetgearError(e),
      detail: describeErrorDetail(e),
    });
    if (opts.onError?.(e, toast)) return;
    toast.style = Toast.Style.Failure;
    toast.title = `${label} failed`;
    toast.message = describeNetgearError(e);
  }
}
