import { useEffect, useState } from "react";
import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  showToast,
  Toast,
} from "@raycast/api";
import { runNetworkQuality } from "./speed-test/run";
import { toSpeedTestRecord } from "./speed-test/parse";
import { loadHistory, saveHistory } from "./speed-test/history";
import { SpeedTestRecord } from "./speed-test/types";
import { historyImage, metricsImage, panelImage } from "./speed-test/heroes";

const HISTORY_LIMIT = 20;
const RECENT_ROWS = 5;

function renderMarkdown(history: SpeedTestRecord[]): string {
  const [latest] = history;
  if (!latest) {
    return "No speed test yet — press `↩` to run one.";
  }

  const spark = historyImage(history);
  const lines = [
    "# Speed Test",
    "",
    `_Last measured ${new Date(latest.timestamp).toLocaleString("de-DE")}${latest.full ? "" : " (quick — under-reads)"}_`,
    "",
    `![Speed](${panelImage(latest, history)})`,
    "",
    `![Metrics](${metricsImage(latest)})`,
  ];
  // No Detail.Metadata sidebar: the panel carries download/upload, the metrics
  // row latency, responsiveness and the interface; the history chart and the
  // recent tests below stay a chart and a table (reference data).
  if (spark)
    lines.push("", "## History (download, Mbps)", "", `![History](${spark})`);

  if (history.length > 0) {
    lines.push(
      "",
      "## Recent Tests",
      "",
      "| Time | Down | Up | Latency |",
      "|-|-|-|-|",
      ...history.slice(0, RECENT_ROWS).map((r) => {
        const when = new Date(r.timestamp).toLocaleString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        const up = r.ulMbps !== null ? `${r.ulMbps} Mbps` : "—";
        return `| ${when} | ${r.dlMbps} Mbps | ${up} | ${r.latencyMs} ms |`;
      }),
    );
  }

  return lines.join("\n");
}

export default function SpeedTest() {
  const [history, setHistory] = useState<SpeedTestRecord[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    loadHistory().then((h) => {
      setHistory(h);
      setHistoryLoaded(true);
    });
  }, []);

  async function runTest(full: boolean) {
    setIsRunning(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: full
        ? "Running full test (up + down, ~170 MB)…"
        : "Running quick test…",
    });
    try {
      const result = await runNetworkQuality(full);
      const record = toSpeedTestRecord(result, full);
      setHistory((prev) => {
        const next = [record, ...prev].slice(0, HISTORY_LIMIT);
        saveHistory(next);
        return next;
      });
      toast.style = Toast.Style.Success;
      toast.title = `${record.dlMbps} Mbps down${record.ulMbps !== null ? ` / ${record.ulMbps} Mbps up` : ""}`;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Speed test failed";
      toast.message = String(e);
    } finally {
      setIsRunning(false);
    }
  }

  // No auto-run on open — a test burns metered LTE data, so the command
  // opens showing the latest saved result (or an empty-state prompt) and
  // only runs on an explicit action.
  return (
    <Detail
      isLoading={!historyLoaded || isRunning}
      markdown={historyLoaded ? renderMarkdown(history) : "Loading…"}
      actions={
        <ActionPanel>
          <Action
            title="Run Quick Test"
            icon={Icon.Gauge}
            onAction={() => runTest(false)}
          />
          <Action
            title="Run Full Test"
            icon={Icon.ArrowUpCircle}
            shortcut={{ modifiers: ["cmd"], key: "return" }}
            onAction={() => runTest(true)}
          />
        </ActionPanel>
      }
    />
  );
}
