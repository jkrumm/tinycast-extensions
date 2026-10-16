// Vitest setup (unit and e2e projects): points the van store at a throwaway
// directory — never the real ~/.local/state/van-sampler — and registers the
// fake host's paths. Test helpers `clearVanState` / `vanStatePath` reset and
// address that directory.

import { environment } from "@raycast/api";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll } from "vitest";
import { configureVanRuntime } from "./runtime";
import { vanDir } from "./store";

const stateDir = mkdtempSync(join(tmpdir(), "van-state-"));
process.env.VAN_SAMPLER_DIR = stateDir;
delete process.env.VAN_BLE_BIN;

configureVanRuntime(() => ({
  supportDir: environment.supportPath,
  assetsDir: environment.assetsPath,
  preferences: {
    apiTokenRef: "",
    baseUrl: "",
    netgearPasswordRef: "",
    // An override, so no test ever reaches the Keychain or 1Password.
    victronKey: "adeccb947395801a4dd45a2eaa44bf17",
    victronKeyRef: "",
  },
}));

afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

export function clearVanState(): void {
  rmSync(vanDir(), { recursive: true, force: true });
}

export const vanStatePath = (name: string): string => join(vanDir(), name);
