// Persists the router's own Wi-Fi credentials in macOS Keychain — same
// SecretRunner/service pattern as pin-store.ts, one fixed account instead of
// per-SIM — so the Mac can rejoin them on its own the next time it drops off
// the router's network (see flows.ts's `ensureRouterReachable`). Captured
// opportunistically whenever an Admin session reads them (session.ts's
// `withAdmin`, netgear.tsx's `loadStatus`), not just right before a planned
// reboot. No `@raycast/api` import — keeps this resolvable under vitest.

import {
  KEYCHAIN_SERVICE,
  SecretRunner,
  SystemSecretRunner,
} from "../lib/secrets";
import { WifiCredentials } from "./wifi";

const SECURITY_BIN = "/usr/bin/security";
const ACCOUNT = "netgear-wifi";

// Port — a store for the router's own Wi-Fi credentials. Production uses
// `KeychainWifiCredsStore`; tests supply a fake so no real Keychain is
// touched.
export interface WifiCredsStore {
  get(): Promise<WifiCredentials | null>;
  set(creds: WifiCredentials): Promise<void>;
}

const defaultRunner = new SystemSecretRunner();

export class KeychainWifiCredsStore implements WifiCredsStore {
  constructor(private readonly runner: SecretRunner = defaultRunner) {}

  async get(): Promise<WifiCredentials | null> {
    try {
      const value = await this.runner.exec(SECURITY_BIN, [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        ACCOUNT,
        "-w",
      ]);
      const trimmed = value.trim();
      if (!trimmed) return null;
      const parsed = JSON.parse(trimmed) as Partial<WifiCredentials>;
      if (!parsed.ssid || !parsed.passphrase) return null;
      return { ssid: parsed.ssid, passphrase: parsed.passphrase };
    } catch {
      return null;
    }
  }

  async set(creds: WifiCredentials): Promise<void> {
    // -U: update the existing entry in place, same as pin-store.ts.
    await this.runner.exec(SECURITY_BIN, [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      ACCOUNT,
      "-w",
      JSON.stringify(creds),
    ]);
  }
}

// Best-effort: a failed capture must never break the admin action it rode in
// on. The passphrase never touches LocalStorage, the UI, or a log line —
// only this Keychain entry, same guarantee as every other secret here.
export async function captureWifiCredentials(opts: {
  client: { getWifiCredentials(): Promise<WifiCredentials | null> };
  store: WifiCredsStore;
}): Promise<void> {
  try {
    const creds = await opts.client.getWifiCredentials();
    if (creds) await opts.store.set(creds);
  } catch {
    // Best-effort — see above.
  }
}
