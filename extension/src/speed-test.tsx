import { useEffect, useState } from "react";
import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  LocalStorage,
  showToast,
  Toast,
} from "@raycast/api";
import { runNetworkQuality } from "./speed-test/run";
import { toSpeedTestRecord } from "./speed-test/parse";
import { SpeedTestRecord } from "./speed-test/types";
import {
  RAYCAST_COLOR,
  RingGaugeSpec,
  ringGaugeRow,
  sparkline,
  toDataUri,
} from "./lib/svg";

const HISTORY_KEY = "speed-test-history";
const HISTORY_LIMIT = 20;

// The arc's own scale, not a fixed ceiling: always at least 150 Mbps, or
// 20% above the actual result — so a fast connection's arc never maxes out
// and reads as "pinned"/broken, and a slow one isn't stretched across an
// almost-empty ring either.
function gaugeScaleMbps(mbps: number): number {
  return Math.max(150, mbps * 1.2);
}

function gaugePercent(mbps: number): number {
  return Math.min(100, Math.round((mbps / gaugeScaleMbps(mbps)) * 100));
}

async function loadHistory(): Promise<SpeedTestRecord[]> {
  const raw = await LocalStorage.getItem<string>(HISTORY_KEY);
  return raw ? (JSON.parse(raw) as SpeedTestRecord[]) : [];
}

async function saveHistory(history: SpeedTestRecord[]): Promise<void> {
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function heroImages(
  record: SpeedTestRecord,
  history: SpeedTestRecord[],
): string[] {
  // Big raw Mbps number in the centre, "Mbps" small below it, no percentage
  // anywhere — the arc fill is the only place gaugePercent's ratio shows.
  // Fixed colours (not thresholdColor): "% of an arbitrary ceiling" has no
  // good/bad reading on a metered LTE link.
  const gauges: RingGaugeSpec[] = [
    {
      percent: gaugePercent(record.dlMbps),
      label: "Download",
      valueText: String(record.dlMbps),
      sublabel: "Mbps",
      color: RAYCAST_COLOR.blue,
    },
  ];
  if (record.ulMbps !== null) {
    gauges.push({
      percent: gaugePercent(record.ulMbps),
      label: "Upload",
      valueText: String(record.ulMbps),
      sublabel: "Mbps",
      color: RAYCAST_COLOR.purple,
    });
  }
  const images = [toDataUri(ringGaugeRow(gauges))];

  const chronological = [...history].reverse();
  if (chronological.length > 1) {
    images.push(
      toDataUri(
        sparkline({
          values: chronological.map((r) => r.dlMbps),
          formatValue: (v) => `${v.toFixed(0)} Mbps`,
        }),
      ),
    );
  }

  return images;
}

function renderMarkdown(
  record: SpeedTestRecord | null,
  history: SpeedTestRecord[],
): string {
  if (!record) return "Running quick test…";

  const [gauge, spark] = heroImages(record, history);
  const lines = [
    "# Speed Test",
    "",
    `**Data used this test: ${record.dataUsedMB} MB**${record.full ? "" : " _(quick test under-reads — TCP never ramps up in ~4s)_"}`,
    "",
    `![Speed](${gauge})`,
  ];
  if (spark)
    lines.push("", "## History (download, Mbps)", "", `![History](${spark})`);

  // No Detail.Metadata sidebar — the gauge(s) above already carry
  // download/upload; a table covers latency and the rest, now that
  // Tinycast beta renders markdown tables as a real grid.
  lines.push("", "| | |", "|-|-|", `| Latency | ${record.latencyMs} ms |`);
  if (record.responsiveness !== null) {
    lines.push(`| Responsiveness | ${Math.round(record.responsiveness)} RPM |`);
  }
  lines.push(
    `| Interface | ${record.interfaceName} |`,
    `| Test type | ${record.full ? "Full (up + down)" : "Quick (download-only)"} |`,
    `| Ran | ${new Date(record.timestamp).toLocaleString("de-DE")} |`,
  );

  if (history.length > 0) {
    lines.push(
      "",
      "## Recent Tests",
      "",
      "| Time | Down | Up | Latency | Data | Type |",
      "|-|-|-|-|-|-|",
      ...history.slice(0, 10).map((r) => {
        const when = new Date(r.timestamp).toLocaleString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        const up = r.ulMbps !== null ? `${r.ulMbps} Mbps` : "—";
        return `| ${when} | ${r.dlMbps} Mbps | ${up} | ${r.latencyMs} ms | ${r.dataUsedMB} MB | ${r.full ? "Full" : "Quick"} |`;
      }),
    );
  }

  return lines.join("\n");
}

export default function SpeedTest() {
  const [history, setHistory] = useState<SpeedTestRecord[]>([]);
  const [current, setCurrent] = useState<SpeedTestRecord | null>(null);
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
      setCurrent(record);
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

  // Runs once, on open — matches every other command's "just show me the
  // current state" model. A second/third run only ever happens on an
  // explicit action.
  useEffect(() => {
    if (historyLoaded && !current && !isRunning) {
      runTest(false);
    }
  }, [historyLoaded]);

  return (
    <Detail
      isLoading={isRunning}
      markdown={renderMarkdown(current, history)}
      actions={
        <ActionPanel>
          <Action
            title="Quick Test"
            icon={Icon.Gauge}
            onAction={() => runTest(false)}
          />
          <Action
            title="Full Test (Upload + Download, ~170 MB)"
            icon={Icon.ArrowUpCircle}
            onAction={() => runTest(true)}
          />
        </ActionPanel>
      }
    />
  );
}
