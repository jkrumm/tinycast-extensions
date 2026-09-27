import { execFile } from "child_process";
import { promisify } from "util";
import { parseNetworkQuality } from "./parse";
import { NetworkQualityResult } from "./types";

const execFileAsync = promisify(execFile);
const NETWORK_QUALITY_BIN = "/usr/bin/networkQuality";

// Quick: download-only, ~4s, ~15 MB. Full: up + down, ~10-20s, ~170 MB — the
// quick test under-reads (TCP ramp-up never completes), which is why the
// full test exists as an explicit, separately-labelled action rather than
// the default.
export async function runNetworkQuality(
  full: boolean,
): Promise<NetworkQualityResult> {
  const args = full ? ["-c"] : ["-c", "-M", "4", "-u"];
  const { stdout } = await execFileAsync(NETWORK_QUALITY_BIN, args);
  return parseNetworkQuality(stdout);
}
