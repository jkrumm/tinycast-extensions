// The print CLI: `make print ARGS="<file> [flags]"` runs it from source, `make
// print-cli` bundles it to assets/print-cli.js (what the Tinycast commands and
// the agents' `bun extension/assets/print-cli.js` run). Plain bun: nothing here
// may import `@raycast/api`. Flags and the JSON contract: `--help`.

import { resolve } from "path";
import { runPrintCli } from "../src/print/cli";
import { createCups } from "../src/print/cups";
import { systemCupsPorts, systemStat } from "../src/print/system";

const outcome = await runPrintCli(process.argv.slice(2), {
  cups: createCups(systemCupsPorts()),
  stat: systemStat,
  resolve,
});
console.log(outcome.text);
process.exit(outcome.code);
