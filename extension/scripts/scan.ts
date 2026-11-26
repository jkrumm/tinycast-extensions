// The scan CLI: `--check` for the pre-flight (what the Tinycast command runs),
// otherwise one scan, run as a detached bun process that outlives the Tinycast
// command (bundled to assets/scan-cli.js by `make scan-cli`; `make scan` runs
// it from source). Plain bun — nothing here may import `@raycast/api`.
//
//   --mode feeder|fronts|backs|flatbed|more  (default feeder)
//   --out-dir <dir>                      the inbox (or SCAN_INBOX)
//   --host <url>                         skip the Bonjour lookup
//   --check                              pre-flight only
//   --no-notify                          no macOS notification
//   --measure <file.jpg> [more...]       print each file's ink share (blank guard calibration), no scanner
//
// SCAN_STATE_DIR overrides ~/.local/state/scan. Prints ONE JSON line
// `{ ok, message? }`; exit 0 for --check either way, 1 for a failed scan.

import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseArgs } from "util";
import { isBlankPage } from "../src/scan/blank";
import { SCAN_MODES, ScanMode } from "../src/scan/escl";
import { measureInk } from "../src/scan/ink";
import { keepAwake } from "../src/scan/keep-awake";
import { checkJob, JobOptions, runJob, systemJobDeps } from "../src/scan/job";
import { appendScanLog } from "../src/scan/log";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    measure: { type: "boolean", default: false },
    mode: { type: "string", default: "feeder" },
    "out-dir": { type: "string" },
    host: { type: "string" },
    check: { type: "boolean", default: false },
    "no-notify": { type: "boolean", default: false },
  },
});

const print = (result: { ok: boolean; message?: string }): void =>
  console.log(JSON.stringify(result));

// Calibration aid for the blank guard: touches no scanner.
if (values.measure) {
  const shares = await measureInk(positionals, (line) => console.error(line));
  positionals.forEach((path, i) => {
    const share = shares[i];
    console.log(
      share === null
        ? `n/a\terror\t${path}`
        : `${(share * 100).toFixed(4)}\t${isBlankPage(share) ? "blank" : "ink"}\t${path}`,
    );
  });
  process.exit(0);
}

const mode = values.mode as ScanMode;
const outDir = values["out-dir"] || process.env.SCAN_INBOX;
if (!SCAN_MODES.includes(mode)) {
  print({ ok: false, message: `Unknown mode "${values.mode}"` });
  process.exit(values.check ? 0 : 1);
}
if (!outDir) {
  print({
    ok: false,
    message: "No scan inbox given (--out-dir or SCAN_INBOX)",
  });
  process.exit(values.check ? 0 : 1);
}

const stateDir =
  process.env.SCAN_STATE_DIR || join(homedir(), ".local/state/scan");
mkdirSync(stateDir, { recursive: true });
const opts: JobOptions = {
  mode,
  outDir,
  host: values.host?.trim() || undefined,
  stateDir,
  notify: !values["no-notify"],
};
const deps = systemJobDeps(stateDir);

if (values.check) {
  print(await checkJob(opts, deps));
  process.exit(0);
}

// A batch takes minutes; an idle sleep would end it halfway.
keepAwake({
  pid: process.pid,
  log: (line) => appendScanLog(join(stateDir, "scan.log"), line, new Date()),
});

const result = await runJob(opts, deps);
print(result);
process.exit(result.ok ? 0 : 1);
