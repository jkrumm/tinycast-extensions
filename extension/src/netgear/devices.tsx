import { Detail } from "@raycast/api";
import { RouterStatus } from "./types";

function connectedDevicesMarkdown(status: RouterStatus): string {
  const lines = ["# Connected Devices", ""];
  if (status.connectedDevices.length === 0) {
    lines.push("_No devices connected._");
    return lines.join("\n");
  }
  lines.push(
    "| Name | IP | Media | MAC |",
    "|-|-|-|-|",
    ...status.connectedDevices.map(
      (d) => `| ${d.name || "—"} | ${d.ip} | ${d.media} | ${d.mac} |`,
    ),
  );
  return lines.join("\n");
}

export function ConnectedDevices({ status }: { status: RouterStatus }) {
  return (
    <Detail
      navigationTitle="Connected Devices"
      markdown={connectedDevicesMarkdown(status)}
    />
  );
}
