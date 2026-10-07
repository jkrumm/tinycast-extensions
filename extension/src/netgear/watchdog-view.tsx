import { Detail } from "@raycast/api";
import { WatchdogStorage } from "./watchdog-storage";

function formatTime(at: number, timeOnly = false): string {
  return timeOnly
    ? new Date(at).toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : new Date(at).toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

// Raw error text goes into a markdown table cell: no pipes, no newlines.
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ⏎ ");
}

function watchdogLogMarkdown(storage: WatchdogStorage): string {
  const lines = ["# Watchdog Log", ""];
  if (storage.events.length === 0) {
    lines.push(
      "_No runs yet — enable Background Refresh once in Tinycast Settings → Extensions → Netgear Watchdog, or wait for the 1-minute interval to fire._",
    );
    return lines.join("\n");
  }
  const counts = Object.entries(storage.counts)
    .filter(
      ([kind]) =>
        kind !== "ok" &&
        kind !== "idle" &&
        kind !== "battery-empty" &&
        kind !== "no-service",
    )
    .map(([kind, n]) => `${kind} ${n}`)
    .join(" · ");
  if (storage.since) {
    lines.push(
      `_Since ${formatTime(storage.since)}: ${storage.counts.ok ?? 0} OK ticks${counts ? ` · ${counts}` : ""}_`,
      "",
    );
  }
  lines.push(
    "| Time | Event | Message |",
    "|-|-|-|",
    ...storage.events.flatMap((e) => {
      const when = e.firstAt
        ? `${formatTime(e.firstAt)} – ${formatTime(e.at, true)}`
        : formatTime(e.at);
      const times = e.count ? ` ×${e.count}` : "";
      const row = `| ${when} | ${e.kind}${times} | ${e.message} |`;
      // A second row, not `<br>` — Tinycast's table renderer may not honour
      // inline HTML, but an empty-celled row always reads as "under".
      return e.detail ? [row, `| | | raw: ${escapeCell(e.detail)} |`] : [row];
    }),
  );
  return lines.join("\n");
}

export function WatchdogLog({ storage }: { storage: WatchdogStorage }) {
  return (
    <Detail
      navigationTitle="Watchdog Log"
      markdown={watchdogLogMarkdown(storage)}
    />
  );
}
