import { showHUD } from "@raycast/api";
import { ScanMode } from "./escl";
import {
  DirectAction,
  runDirectCommand,
  runScanCommand,
  ScanCommandPorts,
} from "./actions";
import { cliPorts } from "./cli-run";

const ports: ScanCommandPorts = { ...cliPorts, hud: (text) => showHUD(text) };

// One-liner command bodies: `export default scanCommand("fronts");`
export const scanCommand = (mode: ScanMode) => async () => {
  await runScanCommand(mode, ports);
};

// `export default scanDirectCommand("submit");` — Submit Scan / Discard Scan.
export const scanDirectCommand = (action: DirectAction) => async () => {
  await runDirectCommand(action, ports);
};
