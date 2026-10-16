// The launchd entry point for the Netgear watchdog: one tick, then exit.
// `launchd/com.jkrumm.netgear-watchdog.plist.tmpl` runs it every 60 s under
// `jobrun`, so a crash records the run red and `jobs-grade` sees a stalled
// watchdog. Plain bun — nothing here may import `@raycast/api`.
// NETGEAR_HOST / NETGEAR_WATCHDOG_DIR / NETGEAR_LOG_DIR override the router,
// the state dir and the log dir (the fake router, smoke runs).

import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { appendLogLine, LogEntry } from "../src/lib/action-log";
import {
  getSecret,
  KeychainOnlyRunner,
  SecretUnavailableError,
} from "../src/lib/secrets";
import { DEFAULT_HOST } from "../src/netgear/adapters";
import { NetgearClient } from "../src/netgear/client";
import { CurlNetgearHttp } from "../src/netgear/transport";
import { runWatchdogOnce } from "../src/netgear/watchdog-runner";
import { DEFAULT_WATCHDOG_DIR } from "../src/netgear/watchdog-storage";

const dir = process.env.NETGEAR_WATCHDOG_DIR || DEFAULT_WATCHDOG_DIR;
const host = (process.env.NETGEAR_HOST || DEFAULT_HOST).replace(/\/$/, "");
// Where the Tinycast view's "Show Netgear Log" reads — one log for both.
const supportDir =
  process.env.NETGEAR_LOG_DIR ||
  join(
    homedir(),
    "Library/Application Support/com.tinycast.app.beta/extension-support/jkrumm",
  );

mkdirSync(dir, { recursive: true });
mkdirSync(supportDir, { recursive: true });

const event = await runWatchdogOnce({
  dir,
  getClient: async () =>
    new NetgearClient({
      host,
      transport: new CurlNetgearHttp(join(dir, "netgear-cookies.jar")),
    }),
  // Keychain only (`make secrets` seeds it): `op read` would hang on a biometric prompt.
  getPassword: async () => {
    try {
      return await getSecret(
        "netgearPassword",
        {
          apiTokenRef: "",
          netgearPasswordRef: "",
          victronKeyRef: "",
        },
        new KeychainOnlyRunner(),
      );
    } catch (e) {
      if (e instanceof SecretUnavailableError) return null;
      throw e;
    }
  },
  log: (entry: LogEntry) =>
    appendLogLine({ path: join(supportDir, "netgear.log"), ...entry }),
});

console.log(event ? `${event.kind}: ${event.message}` : "paused");
