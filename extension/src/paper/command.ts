// The no-view commands, bound to Raycast: one-liner command bodies such as
// `export default scanCommand("fronts");`. The HUD shows paper's own message.

import { showHUD } from "@raycast/api";
import { selectedFinderPaths } from "../print/finder";
import {
  ScanMode,
  Sides,
  cancelAllPrints,
  printPaths,
  scanDiscard,
  scanStart,
  scanSubmit,
} from "./actions";
import { runPaper } from "./run";

export const scanCommand = (mode: ScanMode) => async () => {
  await showHUD((await scanStart(mode, runPaper)).message);
};

export const scanSubmitCommand = async () => {
  await showHUD((await scanSubmit(runPaper)).message);
};

export const scanDiscardCommand = async () => {
  await showHUD((await scanDiscard(runPaper)).message);
};

export const printSelectionCommand = (sides: Sides) => async () => {
  const paths = await selectedFinderPaths();
  await showHUD((await printPaths(sides, paths, runPaper)).message);
};

export const cancelPrintsCommand = async () => {
  await showHUD((await cancelAllPrints(runPaper)).message);
};
