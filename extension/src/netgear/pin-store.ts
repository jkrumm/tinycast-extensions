// Per-SIM PIN storage in macOS Keychain — same service and shell-out
// mechanism as `lib/secrets.ts` (`/usr/bin/security`), but keyed by ICCID
// rather than a fixed secret name, since a SIM swap must not reuse another
// SIM's saved PIN. No `@raycast/api` import — keeps this resolvable under
// vitest, same reason as `lib/secrets.ts`.

import {
  KEYCHAIN_SERVICE,
  SecretRunner,
  SystemSecretRunner,
} from "../lib/secrets";

const SECURITY_BIN = "/usr/bin/security";

// Port — a per-SIM PIN store, keyed by ICCID. Production uses
// `KeychainSimPinStore`; tests supply a fake so no real Keychain is touched.
export interface SimPinStore {
  get(iccid: string): Promise<string | null>;
  set(iccid: string, pin: string): Promise<void>;
  delete(iccid: string): Promise<void>;
  // Reads and deletes in one claim — returns the PIN only to the caller
  // whose delete succeeded, so two concurrent automatic attempts (watchdog
  // tick + command open) can never both enter it.
  take(iccid: string): Promise<string | null>;
  // The last SIM seen unlocked — the fallback identity while a Locked SIM
  // hides its ICCID.
  getLastIccid(): Promise<string | null>;
  setLastIccid(iccid: string): Promise<void>;
}

const LAST_ICCID_ACCOUNT = "netgear-sim-last-iccid";

function accountFor(iccid: string): string {
  return `netgear-sim-pin:${iccid}`;
}

const defaultRunner = new SystemSecretRunner();

export class KeychainSimPinStore implements SimPinStore {
  constructor(private readonly runner: SecretRunner = defaultRunner) {}

  get(iccid: string): Promise<string | null> {
    return iccid ? this.read(accountFor(iccid)) : Promise.resolve(null);
  }

  async set(iccid: string, pin: string): Promise<void> {
    if (iccid) await this.write(accountFor(iccid), pin);
  }

  getLastIccid(): Promise<string | null> {
    return this.read(LAST_ICCID_ACCOUNT);
  }

  async setLastIccid(iccid: string): Promise<void> {
    if (!iccid || (await this.getLastIccid()) === iccid) return;
    await this.write(LAST_ICCID_ACCOUNT, iccid);
  }

  private async read(account: string): Promise<string | null> {
    try {
      const value = await this.runner.exec(SECURITY_BIN, [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        account,
        "-w",
      ]);
      return value.trim() || null;
    } catch {
      return null;
    }
  }

  private async write(account: string, value: string): Promise<void> {
    // -U: update the existing entry in place rather than failing with a
    // duplicate-item error on the second run.
    await this.runner.exec(SECURITY_BIN, [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
      value,
    ]);
  }

  async delete(iccid: string): Promise<void> {
    if (!iccid) return;
    try {
      await this.runner.exec(SECURITY_BIN, [
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        accountFor(iccid),
      ]);
    } catch {
      // Already absent — deleting a nonexistent entry isn't an error here.
    }
  }

  async take(iccid: string): Promise<string | null> {
    const pin = await this.get(iccid);
    if (!pin) return null;
    try {
      await this.runner.exec(SECURITY_BIN, [
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        accountFor(iccid),
      ]);
    } catch {
      return null; // someone else claimed it first
    }
    return pin;
  }
}
