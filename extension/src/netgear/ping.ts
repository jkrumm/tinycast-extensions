// The Signal Meter's packet probe: four quick ICMP echoes to a public resolver,
// so the radio numbers can be read next to what the link really delivers
// (latency, loss). Read-only toward the network, never touches the router.
// Callback-style `execFile`: ping exits non-zero when packets are lost, and the
// summary on stdout is exactly what is wanted then.

import { execFile } from "child_process";
import { PingStats, parsePingSummary } from "./signal";

const PING_BIN = "/sbin/ping";
const PING_ARGS = ["-c", "4", "-i", "0.25", "-t", "3", "1.1.1.1"];

// null: ping could not run or printed no summary — unknown, not "100% loss".
export function runPing(): Promise<PingStats | null> {
  return new Promise((resolve) => {
    execFile(PING_BIN, PING_ARGS, (_error, stdout) => {
      resolve(parsePingSummary(String(stdout ?? "")));
    });
  });
}
