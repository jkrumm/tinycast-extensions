import { Detail } from "@raycast/api";
import { readLogTail } from "../lib/action-log";
import { netgearLogPath } from "./session";

const TAIL_LINES = 80;

// The persistent action log (lib/action-log.ts), newest line last — read
// fresh on every mount, so reopening the view shows what just happened.
function logMarkdown(path: string): string {
  const lines = readLogTail(path, TAIL_LINES);
  const body = lines.length
    ? lines.join("\n")
    : "No Netgear actions logged yet.";
  return ["# Netgear Log", "", "```", body, "```", "", `\`${path}\``].join(
    "\n",
  );
}

export function NetgearLog() {
  return (
    <Detail
      navigationTitle="Netgear Log"
      markdown={logMarkdown(netgearLogPath())}
    />
  );
}
