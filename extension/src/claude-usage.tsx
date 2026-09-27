import {
  Detail,
  ActionPanel,
  Action,
  Icon,
  openExtensionPreferences,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { getQuota, isStaleHint } from "./usage/quota";
import { getTimeseries, getSummary, aggregateSpend } from "./usage/spend";
import {
  formatUtilization,
  formatRelativeReset,
  formatSpend,
} from "./usage/format";
import { isQuotaError } from "./usage/types";

async function loadUsage() {
  const [quota, timeseries, summary] = await Promise.all([
    getQuota(),
    getTimeseries(),
    getSummary(),
  ]);
  return { quota, spend: aggregateSpend(timeseries), summary };
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

  const lines = ["# Claude Usage", ""];

  if (isStaleHint(quota.fetched_at)) {
    const ageMin = Math.round((Date.now() / 1000 - quota.fetched_at) / 60);
    lines.push(`_Stale — last fetched ${ageMin}m ago._`, "");
  }

  lines.push("## Quota", "");
  lines.push(
    `- **5h**: ${formatUtilization(quota.five_hour)} — resets in ${formatRelativeReset(quota.five_hour.resets_at_epoch)}`,
  );
  lines.push(
    `- **7d (all models)**: ${formatUtilization(quota.seven_day)} — resets in ${formatRelativeReset(quota.seven_day.resets_at_epoch)}`,
  );
  lines.push(
    `- **7d (Sonnet)**: ${formatUtilization(quota.seven_day_sonnet)} — resets in ${formatRelativeReset(quota.seven_day_sonnet.resets_at_epoch)}`,
  );

  lines.push("", "## Spend", "");
  for (const [lane, amount] of Object.entries(spend.today)) {
    lines.push(`- **${lane}** (today): ${formatSpend(amount)}`);
  }
  lines.push(`- **Today total**: ${formatSpend(spend.todayTotal)}`);
  lines.push(`- **7-day total**: ${formatSpend(spend.sevenDayTotal)}`);

  lines.push(
    "",
    `_${summary.total} events tracked, most recent ${new Date(summary.maxTs).toLocaleString()}_`,
  );

  return lines.join("\n");
}
