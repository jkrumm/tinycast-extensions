// The impure half of talking to `print-cli` from a Tinycast command or view: the
// bun call (shared with scan through lib/bun-cli) and the preferences. The
// no-view commands (`command.ts`) and the printer view (`view-run.ts`) share it.

import { getPreferenceValues } from "@raycast/api";
import { runBunScript } from "../lib/bun-cli";
import { Preferences } from "../lib/preferences";
import { PrintPorts } from "./actions";

export const PRINT_CLI = "print-cli.js";

export const printPorts: PrintPorts = {
  preferences: () => getPreferenceValues<Preferences>(),
  runCli: (args, timeoutMs) => runBunScript(PRINT_CLI, args, timeoutMs),
};
