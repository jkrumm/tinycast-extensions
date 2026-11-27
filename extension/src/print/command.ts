// The no-view commands: print the Finder selection, one-sided or two-sided, and
// cancel my jobs. One-liner bodies: `export default printSelectionCommand(...)`.

import { showHUD } from "@raycast/api";
import { cancelAllPrints, printPaths } from "./actions";
import { printPorts } from "./cli-run";
import { selectedFinderPaths } from "./finder";
import { Sides } from "./options";

export const printSelectionCommand = (sides: Sides) => async () => {
  const result = await printPaths(
    sides,
    await selectedFinderPaths(),
    printPorts,
  );
  await showHUD(result.message);
};

export const cancelAllCommand = async () => {
  const result = await cancelAllPrints(printPorts);
  await showHUD(result.message);
};
