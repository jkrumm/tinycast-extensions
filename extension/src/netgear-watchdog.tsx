import { updateCommandMetadata } from "@raycast/api";
import { runWatchdogOnce } from "./netgear/watchdog-runner";
import { formatSubtitle } from "./netgear/watchdog";

// No-view background command (package.json: `interval: "1m"`) — off by
// default until run once or toggled on in Settings → Extensions → Netgear
// Watchdog → Background refresh (see AGENTS.md). No toasts/HUD are possible
// during a background run, so `updateCommandMetadata`'s subtitle is the only
// surface. Deliberately narrow: it reboots only as a last resort (3 stuck
// ticks in a row, 30 min cooldown, SIM Ready — fire-and-forget, the following
// ticks recover via the reboot marker); Wi-Fi rejoin is allowed when the Mac
// has zero internet at all, or immediately after such a reboot, and only
// counts if the router answers afterwards. It also watches the router's
// battery (low notice, empty-and-off report, power restored) and sits still
// while the router has no mobile network (limited service) — see
// watchdog.ts for the actual decision tree. Tinycast kills a background run after ~60s
// (docs/netgear-m2.md § Watchdog), so runWatchdogTick's default budget keeps
// every tick well under that, and `onAction` persists a breadcrumb before
// any long action so a kill mid-flight still leaves a trace in the log.
// The tick itself lives in netgear/watchdog-runner.ts: Tinycast never runs a
// background command while a foreground one is open, so the open Netgear view
// runs the same tick (without touching this command's subtitle).
export default async function NetgearWatchdog(): Promise<void> {
  const event = await runWatchdogOnce({ source: "background" });
  await updateCommandMetadata({
    subtitle: event ? formatSubtitle(event) : "Paused",
  });
}
