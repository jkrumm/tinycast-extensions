// Production `probeInternet` for the watchdog: `getStatus().connection ===
// "Connected"` only proves the WWAN radio link is up, not that the mobile
// data plan is actually reachable — a captive-portal-style HTTP check is the
// only way to tell the two apart. Shells out to `curl` for the same reason
// `transport.ts` does (a known quantity, no fetch/cookie ambiguity), even
// though this target isn't the router itself.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const CURL_BIN = "/usr/bin/curl";
// Two independent endpoints, run in parallel: one slow request on LTE must
// not read as an outage (seen live 2026-09-27 — a single-endpoint miss
// triggered a pointless reconnect).
const PROBES: { url: string; expect: string }[] = [
  { url: "http://captive.apple.com/hotspot-detect.html", expect: "200" },
  { url: "http://connectivitycheck.gstatic.com/generate_204", expect: "204" },
];
const TIMEOUT_SECONDS = "8";

async function probe(url: string, expect: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(CURL_BIN, [
      "-s",
      "-m",
      TIMEOUT_SECONDS,
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      url,
    ]);
    return stdout.trim() === expect;
  } catch {
    return false;
  }
}

export async function probeInternet(): Promise<boolean> {
  const results = await Promise.all(PROBES.map((p) => probe(p.url, p.expect)));
  return results.some(Boolean);
}
