// Where the host URL and bearer token come from: the WalkingPad Mac app's own
// storage, so no second copy of the secret exists. The URL is in UserDefaults
// (domain com.jkrumm.walkingpad.client, key hostURL), the token in the login
// Keychain (generic password, service com.jkrumm.walkingpad.client, account
// host-token). The first Keychain read by `security` asks the owner once.
// No @raycast/api import; the exec port is injected so tests need no Keychain.

import { WalkingPadError } from "./client";
import { DEFAULT_START_SPEED, clampSpeed } from "./parse";

export const CLIENT_DOMAIN = "com.jkrumm.walkingpad.client";

export interface HostConfig {
  baseUrl: string;
  token: string;
  startSpeed: number;
}

// Port: resolves with stdout on exit 0, rejects otherwise.
export type Exec = (bin: string, args: string[]) => Promise<string>;

const DEFAULTS_BIN = "/usr/bin/defaults";
const SECURITY_BIN = "/usr/bin/security";

const unconfigured = (what: string): WalkingPadError =>
  new WalkingPadError(
    "unconfigured",
    `${what} — open the WalkingPad app and finish its setup`,
  );

// http(s) only; trailing slash dropped. Never echoed into an error.
export function normalizeUrl(raw: string): string | null {
  const url = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+(\/\S*)?$/.test(url) ? url : null;
}

export async function readConfig(exec: Exec): Promise<HostConfig> {
  const read = (key: string) =>
    exec(DEFAULTS_BIN, ["read", CLIENT_DOMAIN, key]).then(
      (out) => out.trim(),
      () => "",
    );

  const baseUrl = normalizeUrl(await read("hostURL"));
  if (!baseUrl) throw unconfigured("No host URL set");

  const token = await exec(SECURITY_BIN, [
    "find-generic-password",
    "-s",
    CLIENT_DOMAIN,
    "-a",
    "host-token",
    "-w",
  ]).then(
    (out) => out.trim(),
    () => "",
  );
  if (!token) throw unconfigured("Token not readable from the Keychain");

  const stored = Number(await read("startSpeed"));
  const startSpeed =
    Number.isFinite(stored) && stored > 0
      ? clampSpeed(stored)
      : DEFAULT_START_SPEED;
  return { baseUrl, token, startSpeed };
}
