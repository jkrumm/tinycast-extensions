// The launchd entry point for the van sampler: one run, then exit.
// `launchd/com.jkrumm.van-sampler.plist.tmpl` runs it every 15 min under
// `jobrun`, outside Tinycast — a Tinycast background command never ran while a
// view was open. Plain bun — nothing here may import `@raycast/api`.
// VAN_BLE_BIN (the separately signed helper), VAN_SAMPLER_DIR (the state files
// the Van Power view shares) and VAN_SUPPORT_DIR (the capture/trend logs) are
// read where they are used or below; the smoke runs and tests override them.
// Nothing found (out of range, Bluetooth off, paused) is an outcome, not an
// error: the subtitle is printed and the exit code is 0. Only a crash is red.

import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { configureVanRuntime } from "../src/van/runtime";
import { runSamplerOnce } from "../src/van/sampler-runner";
import { vanDir } from "../src/van/store";

// Where Van Power's capture and trend logs live — one log for both writers.
const supportDir =
  process.env.VAN_SUPPORT_DIR ||
  join(
    homedir(),
    "Library/Application Support/com.tinycast.app.beta/extension-support/jkrumm",
  );

mkdirSync(vanDir(), { recursive: true });
mkdirSync(supportDir, { recursive: true });

// No preferences outside Tinycast: the Victron key comes from the Keychain
// only (`make secrets` seeds it), never `op read` — that would hang on a
// biometric prompt.
configureVanRuntime(() => ({
  supportDir,
  assetsDir: "",
  preferences: {
    apiTokenRef: "",
    baseUrl: "",
    netgearPasswordRef: "",
    victronKeyRef: "",
  },
}));

console.log(await runSamplerOnce());
