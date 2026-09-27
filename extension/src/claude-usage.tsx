import {
  Detail,
  ActionPanel,
  Action,
  Icon,
  openExtensionPreferences,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { getQuota, isStaleHint } from "./usage/quota";
import {
  getTimeseries,
  getSummary,
  aggregateSpend,
  topLanesWithOther,
} from "./usage/spend";
import { formatRelativeReset, formatSpend } from "./usage/format";
import { isQuotaError, UsageQuotaOk } from "./usage/types";
import { ringGaugeRow, barChart, sparkline, toDataUri } from "./lib/svg";

const ARGO_DASHBOARD_URL = "https://argo.jkrumm.com";
// Keeps the bar chart to 6 rows max (5 lanes + "other") — argo tracks ~60
// lanes, almost all zero on a given day; a handful of big rows reads better
// than a dense list of small ones.
const SPEND_LANE_LIMIT = 5;

async function loadUsage() {
  const [quota, timeseries, summary] = await Promise.all([
    getQuota(),
    getTimeseries(),
    getSummary(),
  ]);
  return { quota, spend: aggregateSpend(timeseries), summary };
}

function heroImages(
  quota: UsageQuotaOk,
  spend: Awaited<ReturnType<typeof loadUsage>>["spend"],
): string[] {
  const rings = ringGaugeRow([
    {
      percent: quota.five_hour.utilization ?? 0,
      label: "5h",
      sublabel: `resets in ${formatRelativeReset(quota.five_hour.resets_at_epoch)}`,
    },
    {
      percent: quota.seven_day.utilization ?? 0,
      label: "7d",
      sublabel: `resets in ${formatRelativeReset(quota.seven_day.resets_at_epoch)}`,
    },
    {
      percent: quota.seven_day_sonnet.utilization ?? 0,
      label: "7d Sonnet",
      sublabel: `resets in ${formatRelativeReset(quota.seven_day_sonnet.resets_at_epoch)}`,
    },
  ]);

  const lanes = topLanesWithOther(spend.today, SPEND_LANE_LIMIT);
  const bars = barChart(lanes, { formatValue: (v) => formatSpend(v) });

  const spark = sparkline({
    values: spend.dailyTotals.map((d) => d.total),
    formatValue: (v) => formatSpend(v),
  });

  return [toDataUri(rings), toDataUri(bars), toDataUri(spark)];
}

export default function ClaudeUsage() {
  const { data, isLoading, revalidate } = usePromise(loadUsage);

  return (
    <Detail
      isLoading={isLoading}
      markdown={renderMarkdown(data)}
      actions={
        <ActionPanel>
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            onAction={revalidate}
          />
          <Action.OpenInBrowser
            title="Open Argo Usage Dashboard"
            url={ARGO_DASHBOARD_URL}
            icon={Icon.LineChart}
          />
          <Action
            title="Open Extension Preferences"
            icon={Icon.Gear}
            onAction={openExtensionPreferences}
          />
        </ActionPanel>
      }
    />
  );
}

function renderMarkdown(
  data: Awaited<ReturnType<typeof loadUsage>> | undefined,
): string {
  if (!data) return "Loading…";
  const { quota, spend, summary } = data;

  if (isQuotaError(quota)) {
    return [
      "# Claude Usage",
      "",
      `**${quota.error}**`,
      "",
      "Run `/login` in a Claude Code session on the mini, then retry.",
    ].join("\n");
  }

  const [rings, bars, spark] = heroImages(quota, spend);

  const lines = ["# Claude Usage", ""];
  if (isStaleHint(quota.fetched_at)) {
    const ageMin = Math.round((Date.now() / 1000 - quota.fetched_at) / 60);
    lines.push(`_Stale — last fetched ${ageMin}m ago._`, "");
  }
  lines.push(`![Quota](${rings})`, "");
  lines.push("## Spend today", "");
  lines.push(`![Spend by lane](${bars})`, "");
  lines.push("## Last 7 days", "");
  lines.push(`![7-day spend](${spark})`, "");

  // No Detail.Metadata sidebar (the hero images above already carry every
  // quota/spend number) — a table beats a bullet list for the couple of
  // fields that don't fit a chart, now that Tinycast beta renders markdown
  // tables as a real grid.
  lines.push(
    "| | |",
    "|-|-|",
    `| Today total | ${formatSpend(spend.todayTotal)} |`,
    `| 7-day total | ${formatSpend(spend.sevenDayTotal)} |`,
    `| Data freshness | ${isStaleHint(quota.fetched_at) ? "Stale" : `${summary.total} events tracked`} |`,
  );

  return lines.join("\n");
}
