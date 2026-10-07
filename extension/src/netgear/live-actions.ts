// Live mutating actions against the real Netgear MR2100 — reconnect or
// reboot-and-reconnect. NEVER run this from a test or an unattended script;
// per AGENTS.md § Safety it's only run manually, with the user's explicit
// go-ahead, gated on NETGEAR_LIVE_ACTIONS=1 so it's never a side effect of
// `make test` or a background agent loop.
//
// Run with:
//   NETGEAR_LIVE_ACTIONS=1 NETGEAR_HOST=http://192.168.1.1 \
//     NETGEAR_PASSWORD="$(secrets-run read ...)" \
//     bun run src/netgear/live-actions.ts reconnect
//   ...same env, action "reboot" instead of "reconnect"
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CurlNetgearHttp } from "./transport";
import { NetgearClient } from "./client";
import { KeychainSimPinStore } from "./pin-store";
import { NetworksetupWifiRejoiner } from "./wifi";
import { reconnect, rebootAndReconnect, SimPinRequiredError } from "./flows";
import { RouterStatus } from "./types";
import { describeNetgearError } from "./errors";

type LiveAction = "reconnect" | "reboot";

function isLiveAction(value: string | undefined): value is LiveAction {
  return value === "reconnect" || value === "reboot";
}

function logProgress(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Never print the full ICCID (a SIM identifier) — last 4 digits are enough
// to confirm which SIM was acted on without logging something identifying.
function maskedIccid(iccid: string): string {
  if (!iccid) return "(none)";
  return `…${iccid.slice(-4)}`;
}

function printSummary(status: RouterStatus): void {
  console.log("--- Final status ---");
  console.log(`connection: ${status.connection} (${status.connectionText})`);
  console.log(`simStatus: ${status.simStatus}`);
  console.log(`iccid: ${maskedIccid(status.iccid)}`);
  console.log(`activeProfileId: ${status.activeProfileId || "(none)"}`);
  console.log(`roamingAllowed: ${status.roamingAllowed}`);
}

async function main() {
  if (process.env.NETGEAR_LIVE_ACTIONS !== "1") {
    console.log(
      "Skipped — set NETGEAR_LIVE_ACTIONS=1 to run a live action against the real router.",
    );
    return;
  }

  const action = process.argv[2];
  if (!isLiveAction(action)) {
    console.error(
      'Usage: bun run src/netgear/live-actions.ts "reconnect" | "reboot"',
    );
    process.exitCode = 1;
    return;
  }

  const host = process.env.NETGEAR_HOST ?? "http://192.168.1.1";
  const password = process.env.NETGEAR_PASSWORD;
  if (!password) {
    console.error("NETGEAR_PASSWORD is required for a live action.");
    process.exitCode = 1;
    return;
  }

  const jarDir = await mkdtemp(join(tmpdir(), "netgear-live-"));
  const jarPath = join(jarDir, "cookies.jar");
  const client = new NetgearClient({
    host,
    transport: new CurlNetgearHttp(jarPath),
  });
  const pinStore = new KeychainSimPinStore();

  await client.login(password);

  try {
    const status =
      action === "reconnect"
        ? await reconnect({ client, onProgress: logProgress })
        : await rebootAndReconnect({
            client,
            password,
            pinStore,
            wifi: new NetworksetupWifiRejoiner(),
            onProgress: logProgress,
          });
    printSummary(status);
  } catch (err) {
    if (err instanceof SimPinRequiredError) {
      logProgress(
        "SIM PIN required — run the SIM PIN form in the Netgear command.",
      );
      printSummary(err.status);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(describeNetgearError(err));
  process.exit(1);
});
