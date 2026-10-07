import { Detail, ActionPanel, Action, Icon } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo, useRef } from "react";
import { getQuota, isStaleHint } from "./usage/quota";
import { getTimeseries, aggregateSpend } from "./usage/spend";
import { isQuotaError, UsageQuota, SpendAggregate } from "./usage/types";
import { quotaHero, spendHeroes, totalsCards } from "./usage/heroes";
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
            shortcut={{ modifiers: ["cmd"], key: "r" }}
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

  lines.push(`![Quota](${quotaHero(quota)})`, "");

  const spendBanner = freshnessBanner({
    fetchedAt: spendFetchedAt,
    error: spendError,
    offlineLabel: "Spend server not reachable",
  });

  if (!spend) {
    lines.push(spendBanner ?? "_Spend unavailable — argo request failed._", "");
    return [...lines, ...updatingLines].join("\n");
  }

  if (spendBanner) lines.push(spendBanner, "");

  // No Detail.Metadata sidebar — the rings carry the quota, the stat cards
  // today's and the 7-day spend, the charts the breakdown. No table left.
  const { lanes, days } = spendHeroes(spend);
  lines.push(`![Spend totals](${totalsCards(spend)})`, "");
  lines.push("## Spend today", "");
  lines.push(`![Spend by lane](${lanes})`, "");
  lines.push("## Last 7 days", "");
  lines.push(`![7-day spend](${days})`);

  return [...lines, ...updatingLines].join("\n");
}
