import { Detail, ActionPanel, Action, Icon, Keyboard } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo, useRef } from "react";
import { getQuota, isStaleHint } from "./usage/quota";
import { getTimeseries, aggregateSpend } from "./usage/spend";
import {
  hasMultipleAccounts,
  isQuotaError,
  UsageQuota,
  SpendAggregate,
} from "./usage/types";
import {
  periodTotal,
  capacityMetrics,
  capacityPanel,
  quotaPanel,
  spendHeroes,
  usageMetrics,
} from "./usage/heroes";
import { WEEK_SECONDS, quotaLimits } from "./usage/limits";
import { routingMarkdown } from "./usage/routing-text";
import { summarize } from "./usage/summary";
import {
  extraUsageLine,
  formatSpend,
  overflowModelsLine,
} from "./usage/format";
import { freshnessBanner, updatingLine } from "./lib/freshness";

const ARGO_DASHBOARD_URL = "https://argo.jkrumm.com";
interface UsageData {
  quota: UsageQuota;
  spend: SpendAggregate | null;
  spendFetchedAt: number | undefined;
  spendError: unknown;
}

// getQuota() never rejects (it has its own error shape) and getTimeseries()
// can, so the two need separate freshness tracking: quota's own
// `fetched_at`/isStaleHint already covers it ("local"), spend needs its last
// successful fetch remembered across a failing revalidate — a ref rather
// than useCachedPromise's own `error`, since this loader deliberately never
// rejects (a spend failure shouldn't blank out a working quota view).
function useUsage() {
  const lastSpendRef = useRef<
    { spend: SpendAggregate; fetchedAt: number } | undefined
  >(undefined);

  return useCachedPromise(
    async (): Promise<UsageData> => {
      const [quotaResult, spendResult] = await Promise.allSettled([
        getQuota(),
        getTimeseries(),
      ]);
      const quota: UsageQuota =
        quotaResult.status === "fulfilled"
          ? quotaResult.value
          : { error: "Failed to load quota", fetched_at: 0 };

      if (spendResult.status === "fulfilled") {
        const spend = aggregateSpend(spendResult.value);
        const spendFetchedAt = Date.now();
        lastSpendRef.current = { spend, fetchedAt: spendFetchedAt };
        return { quota, spend, spendFetchedAt, spendError: null };
      }
      return {
        quota,
        spend: lastSpendRef.current?.spend ?? null,
        spendFetchedAt: lastSpendRef.current?.fetchedAt,
        spendError: spendResult.reason,
      };
    },
    [],
    { keepPreviousData: true },
  );
}

export default function ClaudeUsage() {
  const { data, isLoading, revalidate } = useUsage();

  const markdown = useMemo(
    () => renderMarkdown(data, isLoading),
    [data, isLoading],
  );

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={revalidate}
          />
          <Action.OpenInBrowser
            title="Open Argo Usage Dashboard"
            url={ARGO_DASHBOARD_URL}
            icon={Icon.LineChart}
          />
        </ActionPanel>
      }
    />
  );
}

function renderMarkdown(
  data: UsageData | undefined,
  isLoading: boolean,
): string {
  if (!data) return "Loading…";
  const { quota, spend, spendFetchedAt, spendError } = data;
  // Stale-while-revalidate: cached data paints instantly, this line is the
  // only sign a refresh is still in flight — kept last so it never shifts
  // the hero images above (Tinycast never re-decodes an unchanged data URI).
  const updating = updatingLine({ fetchedAt: spendFetchedAt, isLoading });
  const updatingLines = updating ? ["", updating] : [];

  if (isQuotaError(quota)) {
    return ["# Claude Usage", "", `**${quota.error}**`, ...updatingLines].join(
      "\n",
    );
  }

  const lines = ["# Claude Usage", ""];
  if (isStaleHint(quota.fetched_at)) {
    const ageMin = Math.round((Date.now() / 1000 - quota.fetched_at) / 60);
    lines.push(`_Stale — last fetched ${ageMin}m ago._`, "");
  }

  const now = Date.now();
  const limits = quotaLimits(quota);
  const spendBanner = freshnessBanner({
    fetchedAt: spendFetchedAt,
    error: spendError,
    offlineLabel: "Spend server not reachable",
  });

  if (hasMultipleAccounts(quota)) {
    // Top down: where work goes now and what needs attention, the pool and
    // each account's week, the 5h windows + spend, then lane routing and the
    // two machines' eligibility. Spend charts come last.
    const summary = summarize(quota.accounts, quota.routing, now / 1000);
    lines.push(
      `**${summary.headline}**${summary.hasPicks ? "" : " _(estimated — this Mac's picker did not answer)_"}`,
      "",
    );
    lines.push(`![Capacity](${capacityPanel(summary)})`, "");
    lines.push(
      `![5h windows and spend](${capacityMetrics({ summary, spend, nowMs: now })})`,
      "",
    );
    const routing = routingMarkdown(quota.accounts, quota.routing, now / 1000);
    if (routing.length > 0) lines.push("## Routing", "", ...routing, "");
  } else {
    lines.push(`![Quota](${quotaPanel(limits, now)})`, "");
    // The panel has room for weekly, 5h and one model cap.
    const overflow = overflowModelsLine(limits.models.slice(1));
    if (overflow) lines.push(overflow, "");
    lines.push(
      `![Pace and spend](${usageMetrics({ limits, spend, nowMs: now })})`,
      "",
    );
  }

  const extra = extraUsageLine(quota.extra_usage);
  if (extra) lines.push(extra, "");

  if (!spend) {
    lines.push(spendBanner ?? "_Spend unavailable — argo request failed._", "");
    return [...lines, ...updatingLines].join("\n");
  }

  if (spendBanner) lines.push(spendBanner, "");

  // No Detail.Metadata sidebar — the panel carries the limits, the metrics
  // row the pace and the spend totals, the charts the breakdown. No table.
  const weekStart =
    limits.weekly.resetsAt === null
      ? null
      : limits.weekly.resetsAt - WEEK_SECONDS;
  const multi = hasMultipleAccounts(quota);
  const { lanes, days } = spendHeroes(spend, multi ? null : weekStart);
  lines.push("## Spend today", "");
  lines.push(`![Spend by lane](${lanes})`, "");
  lines.push(
    `## Last ${spend.dailyTotals.length} days · ${formatSpend(periodTotal(spend))}`,
    "",
  );
  lines.push(`![Daily spend](${days})`);

  return [...lines, ...updatingLines].join("\n");
}
