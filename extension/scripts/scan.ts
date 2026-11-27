// The scan CLI: `--check` for the pre-flight (what the Tinycast command runs),
// otherwise one scan, run as a detached bun process that outlives the Tinycast
// command (bundled to assets/scan-cli.js by `make scan-cli`; `make scan` runs
// it from source). Plain bun — nothing here may import `@raycast/api`.
//
//   --mode feeder|fronts|backs|flatbed|more  (default feeder)
//   --out-dir <dir>                      the inbox (or SCAN_INBOX)
//   --host <url>                         skip the Bonjour lookup
//   --check                              pre-flight only
//   --submit                             Submit Scan: file the pending scan in the inbox, no scanner
//   --discard                            Discard Scan: drop the pending scan, no scanner
//   --force                              with --submit: file even though the last Scan More failed
//   --status                             the pending scan (and the running scan's progress) for a UI
//   --documents                          the inbox: waiting, review, filed (read-only, no scanner)
//   --doc-thumbs                         cache-file thumbnails of those documents
//   --release <name> --as single|split-<n>-<n>…   file a document held in review/ as one document, or as the split the consumer proposed (the first page of each document after the first)
//   --brain-dir <dir> --dokumente-dir <dir>   where the filed documents' index notes and files are
//   --no-notify                          no macOS notification
//   --measure <file.jpg> [more...]       print each file's ink share (blank guard calibration), no scanner
//
// A finished scan stays pending in the state dir until --submit files it (or
// --discard drops it): nothing reaches the inbox on its own
// (src/scan/pending-rules.ts). SCAN_STATE_DIR overrides ~/.local/state/scan.
// Prints ONE JSON line (`{ ok, message? }`, or for --status the pending scan);
// exit 0 for --check, --submit, --discard and --status either way, 1 for a
// failed scan.

import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseArgs } from "util";
import { isBlankPage } from "../src/scan/blank";
import {
  docThumbsResult,
  documentsResult,
  releaseResult,
} from "../src/scan/inbox-cli";
import { SCAN_MODES, ScanMode } from "../src/scan/escl";
import { measureInk } from "../src/scan/ink";
import { keepAwake } from "../src/scan/keep-awake";
import {
  checkJob,
  discardPending,
  JobOptions,
  runJob,
  scanStatus,
  submitNow,
  systemJobDeps,
} from "../src/scan/job";
import { appendScanLog } from "../src/scan/log";
import { stateDirOf } from "../src/scan/state-dir";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    measure: { type: "boolean", default: false },
    mode: { type: "string", default: "feeder" },
    "out-dir": { type: "string" },
    host: { type: "string" },
    check: { type: "boolean", default: false },
    submit: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    discard: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    documents: { type: "boolean", default: false },
    "doc-thumbs": { type: "boolean", default: false },
    release: { type: "string" },
    as: { type: "string" },
    "brain-dir": { type: "string" },
    "dokumente-dir": { type: "string" },
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

const query =
  values.documents || values["doc-thumbs"] || values.release !== undefined;
const direct =
  values.check || values.submit || values.discard || values.status || query;
const mode = values.mode as ScanMode;
const outDir = values["out-dir"] || process.env.SCAN_INBOX;
if (!SCAN_MODES.includes(mode)) {
  print({ ok: false, message: `Unknown mode "${values.mode}"` });
  process.exit(direct ? 0 : 1);
}
if (!outDir && !values.discard && !values.status) {
  print({
    ok: false,
    message: "No scan inbox given (--out-dir or SCAN_INBOX)",
  });
  process.exit(direct ? 0 : 1);
}

const stateDir = stateDirOf(process.env, homedir());
mkdirSync(stateDir, { recursive: true });
const opts: JobOptions = {
  mode,
  outDir: outDir ?? "",
  host: values.host?.trim() || undefined,
  stateDir,
  notify: !values["no-notify"],
  force: values.force,
};
const deps = systemJobDeps(stateDir);

// The inbox queries: read-only, no scanner.
if (query) {
  const dirs = {
    inbox: outDir ?? "",
    brainDir: values["brain-dir"],
    dokumenteDir: values["dokumente-dir"],
  };
  if (values.documents) {
    console.log(JSON.stringify(documentsResult(dirs)));
  } else if (values["doc-thumbs"]) {
    console.log(JSON.stringify(await docThumbsResult({ ...dirs, stateDir })));
  } else {
    console.log(
      JSON.stringify(
        releaseResult({
          inbox: dirs.inbox,
          name: values.release ?? "",
          as: values.as ?? "",
        }),
      ),
    );
  }
  process.exit(0);
}

const log = (line: string): void =>
  appendScanLog(join(stateDir, "scan.log"), line, new Date());

if (values.check) {
  print(await checkJob(opts, deps));
  process.exit(0);
}
// The pending scan, without a scanner.
if (values.status) {
  console.log(JSON.stringify(scanStatus(opts, deps)));
  process.exit(0);
}
if (values.submit || values.discard) {
  print(await (values.submit ? submitNow : discardPending)(opts, deps, log));
  process.exit(0);
}

// A batch takes minutes; an idle sleep would end it halfway.
keepAwake({ pid: process.pid, log });

const result = await runJob(opts, deps);
print(result);
process.exit(result.ok ? 0 : 1);
