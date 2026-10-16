// The process-wide Netgear adapters, free of `@raycast/api` so the launchd
// watchdog (scripts/netgear-watchdog.ts, plain bun) and the Tinycast view
// (session.ts re-exports these) share one construction.

import { KeychainSimPinStore } from "./pin-store";
import { KeychainWifiCredsStore } from "./wifi-creds-store";
import { NetworksetupWifiRejoiner } from "./wifi";

export const DEFAULT_HOST = "http://192.168.1.1";

// One instance per process is enough: the backing store is the Keychain.
export const pinStore = new KeychainSimPinStore();
export const wifiCredsStore = new KeychainWifiCredsStore();
export const wifiRejoiner = new NetworksetupWifiRejoiner();
