// `make van-eval` — the SoC estimator tuning loop. Reads the two files Van Power
// leaves in the extension's support dir (van-log.jsonl: every reading next to
// what the estimator predicted for that moment; van-trends.jsonl: the Victron's
// battery A / V and PV W at native resolution), then replays the estimator
// leave-one-out over every reading and prints how wrong it would have been.
//
//   bun scripts/van-eval.ts [support-dir]
//
// Default dir: the deployed Tinycast Beta extension's support path; override
// with the first argument or $VAN_SUPPORT_DIR. Read-only.

import { homedir } from "os";
import { join } from "path";
import {
  CAPTURE_LOG_FILE,
  TRENDS_LOG_FILE,
  parseCaptureLog,
  parseTrendsLog,
  parseVictronReadLog,
  summariseVictronReads,
  readTextFile,
} from "../src/van/capture-log";
import { evaluate } from "../src/van/soc-eval";
import { defaultLocation } from "../src/van/sun";

const dir =
  process.argv[2] ??
  process.env.VAN_SUPPORT_DIR ??
  join(
    homedir(),
    "Library/Application Support/com.tinycast.app.beta/extension-support/jkrumm",
  );

const logText = readTextFile(join(dir, CAPTURE_LOG_FILE));
const entries = parseCaptureLog(logText);
const reads = summariseVictronReads(parseVictronReadLog(logText));
const trends = parseTrendsLog(readTextFile(join(dir, TRENDS_LOG_FILE)));

const pad2 = (n: number) => String(n).padStart(2, "0");
const stamp = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const num = (v: number | null, digits = 1, width = 7) =>
  (v === null ? "—" : v.toFixed(digits)).padStart(width);
const signed = (v: number | null, width = 7) =>
  (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`).padStart(width);

console.log(`support dir   ${dir}`);
console.log(
  `readings      ${entries.length}  (${CAPTURE_LOG_FILE}${entries.length ? `, ${stamp(entries[0].t)} → ${stamp(entries.at(-1)!.t)}` : ""})`,
);
const seriesInfo = trends
  ? trends.trends
      .map(
        (t) =>
          `${t.samples.length} × ${({ 0xed8f: "A", 0xed8d: "V", 0xec8a: "W" } as Record<number, string>)[t.vreg]}`,
      )
      .join(", ")
  : "none";
console.log(
  `trends        ${seriesInfo}${trends ? `  (${TRENDS_LOG_FILE}, ${stamp(trends.trends[0].samples[0].t)} → ${stamp(trends.trends[0].samples.at(-1)!.t)})` : ""}`,
);

console.log("\nVictron reads (why trend samples are or are not there)");
if (reads.length === 0) {
  console.log(
    "  none logged yet (reads before this log existed are not listed)",
  );
} else {
  for (const r of reads.slice(-12)) {
    console.log(
      `  ${stamp(r.t)}  ${r.outcome.padEnd(9)} ${(r.ms === null ? "—" : `${(r.ms / 1000).toFixed(0)} s`).padStart(5)}  since ${r.sinceMs === null ? "all 72 h" : stamp(r.sinceMs)}${r.history ? " +history" : ""}  new A-samples ${r.newSamples ?? "—"}${r.detail ? `  — ${r.detail}` : ""}`,
    );
  }
}

if (entries.length === 0) {
  console.log(
    "\nNo readings logged yet — open Van Power now and then (each open appends one).",
  );
  process.exit(0);
}

const report = evaluate({
  entries,
  trends,
  location: (t) => defaultLocation(t),
});

console.log(
  "\nper reading (leave-one-out: the estimator without that reading)",
);
console.log(
  `${"time".padEnd(12)}${"measured".padStart(9)}${"LOO".padStart(7)}${"error".padStart(8)}${"Δanchor h".padStart(11)}  ${"d/n".padEnd(4)}${"logged".padStart(8)}${"logErr".padStart(8)}`,
);
for (const r of report.rows) {
  console.log(
    `${stamp(r.t).padEnd(12)}${num(r.measured, 0, 9)}${num(r.predicted, 1)}${signed(r.error, 8)}${num(r.hoursToAnchor, 1, 11)}  ${(r.night ? "night" : "day").padEnd(5)}${r.logged === null ? (r.loggedNote ?? "—").slice(0, 7).padStart(7) : num(r.logged, 1, 7)}${signed(r.loggedError, 8)}`,
  );
}

const { summary } = report;
console.log("\nsummary");
console.log(
  `  leave-one-out   n=${summary.n}  MAE ${num(summary.mae, 2, 0)} %   max ${num(summary.maxAbs, 1, 0)} %`,
);
const skipped = Object.entries(summary.loggedSkippedReasons)
  .map(([reason, n]) => `${n} ${reason}`)
  .join(", ");
console.log(
  `  logged (live)   n=${summary.loggedN}  MAE ${num(summary.loggedMae, 2, 0)} %   max ${num(summary.loggedMaxAbs, 1, 0)} %   (${summary.loggedSkipped} excluded${skipped ? `: ${skipped}` : ""})`,
);
console.log(
  `  fallback load   ${report.loadA.toFixed(2)} A  (instantaneous-current median — only used when no interval is long enough)`,
);

console.log(
  "\nimplied load per interval between anchors (readings and confirmed fulls)",
);
console.log(
  "  L = (charge in − ΔSoC × capacity) / hours — the load the estimator uses inside it",
);
if (report.intervals.length === 0) {
  console.log("  none yet — needs two anchors");
} else {
  console.log(
    `  ${"from".padEnd(12)}${"to".padEnd(12)}${"hours".padStart(6)}${"SoC".padStart(11)}${"charge Ah".padStart(11)}${"L (A)".padStart(8)}  note`,
  );
  for (const i of report.intervals) {
    console.log(
      `  ${stamp(i.from).padEnd(12)}${stamp(i.to).padEnd(12)}${i.hours.toFixed(1).padStart(6)}${`${i.fromSoc.toFixed(0)}→${i.toSoc.toFixed(0)}`.padStart(11)}${i.chargeAh.toFixed(1).padStart(11)}${i.loadA.toFixed(2).padStart(8)}  ${i.fromKind === "full" || i.toKind === "full" ? `${i.fromKind}→${i.toKind} ` : ""}${i.reliable ? "" : "(too short / inside a full: borrows the reliable median)"}`.trimEnd(),
    );
  }
}

console.log("\nestimator constants (van/soc-estimate.ts)");
for (const [name, value] of Object.entries(report.constants)) {
  console.log(`  ${name.padEnd(24)} ${value}`);
}
