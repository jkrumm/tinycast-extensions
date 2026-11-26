import { environment, getPreferenceValues, showHUD } from "@raycast/api";
import { execFile, spawn } from "child_process";
import { Preferences } from "../lib/preferences";
import { ScanMode } from "./escl";
import {
  DirectAction,
  runDirectCommand,
  runScanCommand,
  ScanCommandPorts,
} from "./actions";

const BUN_BIN = "/opt/homebrew/bin/bun";
const PATH = "/opt/homebrew/bin:/usr/bin:/bin";

const cliPath = (): string => `${environment.assetsPath}/scan-cli.js`;

const ports: ScanCommandPorts = {
  preferences: () => getPreferenceValues<Preferences>(),
  runCli: (args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        BUN_BIN,
        [cliPath(), ...args],
        { timeout: timeoutMs, env: { ...process.env, PATH } },
        (_error, stdout) => resolve(String(stdout ?? "")),
      );
    }),
  spawnScan: (args) => {
    const child = spawn(BUN_BIN, [cliPath(), ...args], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH },
    });
    child.unref?.();
  },
  hud: (text) => showHUD(text),
};

// One-liner command bodies: `export default scanCommand("fronts");`
export const scanCommand = (mode: ScanMode) => () =>
  runScanCommand(mode, ports);

// `export default scanDirectCommand("submit");` — Submit Scan / Discard Scan.
export const scanDirectCommand = (action: DirectAction) => () =>
  runDirectCommand(action, ports);
