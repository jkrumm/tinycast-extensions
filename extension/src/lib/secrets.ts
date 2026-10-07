// Resolution chain for values that must never live in this repo (it will go
// public) or be pasted into a preference field on every install: an explicit
// preference override, then macOS Keychain, then 1Password (biometric),
// caching the 1Password result into Keychain so that's the last time it ever
// triggers a prompt. No `@raycast/api` import here — keeps this file (and
// its test) resolvable under vitest, same reason `usage/aggregate.ts` is
// split from `usage/spend.ts`. Callers pass in whatever `getPreferenceValues`
// gave them; this module never reaches into Raycast/Tinycast itself.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SECURITY_BIN = "/usr/bin/security";
const OP_BIN = "/opt/homebrew/bin/op";
const OP_ACCOUNT = "tkrumm";

// Single Keychain service for every secret this extension caches — entries
// are distinguished by account name (the secret key).
export const KEYCHAIN_SERVICE = "tinycast-extensions";

export type SecretKey = "apiToken" | "netgearPassword" | "victronKey";

export class SecretUnavailableError extends Error {
  constructor(key: SecretKey) {
    super(
      `No ${key} available (no preference override, empty Keychain entry, 1Password unreachable) — run \`make secrets\` in tinycast-extensions.`,
    );
    this.name = "SecretUnavailableError";
  }
}

// Port — a shell-command runner. Production uses `SystemSecretRunner`
// (child_process); tests supply a fake so the chain runs with no real
// Keychain or 1Password call.
export interface SecretRunner {
  exec(bin: string, args: string[]): Promise<string>;
}

export class SystemSecretRunner implements SecretRunner {
  async exec(bin: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(bin, args, { encoding: "utf8" });
    return stdout;
  }
}

const defaultRunner = new SystemSecretRunner();

async function readKeychain(
  runner: SecretRunner,
  key: SecretKey,
): Promise<string | null> {
  try {
    const value = await runner.exec(SECURITY_BIN, [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      key,
      "-w",
    ]);
    return value.trim() || null;
  } catch {
    return null;
  }
}

async function writeKeychain(
  runner: SecretRunner,
  key: SecretKey,
  value: string,
): Promise<void> {
  try {
    // -U: update the existing entry in place rather than failing with a
    // duplicate-item error on the second run.
    await runner.exec(SECURITY_BIN, [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      key,
      "-w",
      value,
    ]);
  } catch {
    // Best-effort cache — the caller already has the value either way, so a
    // Keychain write failure shouldn't fail the whole resolution.
  }
}

async function readOnePassword(
  runner: SecretRunner,
  ref: string,
): Promise<string | null> {
  try {
    const value = await runner.exec(OP_BIN, [
      "read",
      ref,
      "--account",
      OP_ACCOUNT,
    ]);
    return value.trim() || null;
  } catch {
    return null;
  }
}

export interface ResolveSecretOptions {
  key: SecretKey;
  ref: string;
  override?: string;
  runner?: SecretRunner;
}

// (a) override → (b) Keychain → (c) 1Password (cached into Keychain on hit).
export async function resolveSecret(
  opts: ResolveSecretOptions,
): Promise<string> {
  const { key, ref, override, runner = defaultRunner } = opts;
  if (override && override.trim() !== "") return override;

  const cached = await readKeychain(runner, key);
  if (cached) return cached;

  const fromOnePassword = await readOnePassword(runner, ref);
  if (fromOnePassword) {
    await writeKeychain(runner, key, fromOnePassword);
    return fromOnePassword;
  }

  throw new SecretUnavailableError(key);
}

// Shape every call site already has from `getPreferenceValues` — a subset of
// `lib/preferences.ts`'s `Preferences`, kept separate so this file never has
// to import it (that path leads back to `@raycast/api`).
export interface SecretPreferences {
  apiToken?: string;
  apiTokenRef: string;
  netgearPassword?: string;
  netgearPasswordRef: string;
  victronKey?: string;
  victronKeyRef: string;
}

const OVERRIDE_PREFERENCE = {
  apiToken: "apiToken",
  netgearPassword: "netgearPassword",
  victronKey: "victronKey",
} as const satisfies Record<SecretKey, keyof SecretPreferences>;

const REF_PREFERENCE = {
  apiToken: "apiTokenRef",
  netgearPassword: "netgearPasswordRef",
  victronKey: "victronKeyRef",
} as const satisfies Record<SecretKey, keyof SecretPreferences>;

// The convenience entry point every command uses:
// `await getSecret("apiToken", prefs())`.
export function getSecret(
  key: SecretKey,
  preferences: SecretPreferences,
  runner?: SecretRunner,
): Promise<string> {
  return resolveSecret({
    key,
    ref: preferences[REF_PREFERENCE[key]] ?? "",
    override: preferences[OVERRIDE_PREFERENCE[key]],
    runner,
  });
}
