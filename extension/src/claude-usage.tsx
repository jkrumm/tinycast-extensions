import {
  Detail,
  ActionPanel,
  Action,
  Icon,
  Keyboard,
  showHUD,
} from "@raycast/api";
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
import {
  IuBudgetReading,
  ageLine,
  canSpendLine,
  freesLine,
  iuBudgetView,
  loadIuBudget,
  modelShare,
  unavailableText,
  usageLine,
  usd0,
} from "./usage/iu-budget";
import { iuBudgetChart } from "./usage/heroes";
import {
  HealthRow,
  StampedHealth,
  healthMarkdown,
  parseFixCommand,
  problemRows,
  rowTitle,
} from "./usage/health";
import { launchRelogin, loadHealth } from "./usage/health-local";
import { freshnessBanner, updatingLine } from "./lib/freshness";

const ARGO_DASHBOARD_URL = "https://argo.jkrumm.com";
interface UsageData {
  quota: UsageQuota;
  spend: SpendAggregate | null;
  spendFetchedAt: number | undefined;
  spendError: unknown;
  iu: IuBudgetReading;
  health: StampedHealth | null;
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
      const [[quotaResult, spendResult], iu, health] = await Promise.all([
        Promise.allSettled([getQuota(), getTimeseries()]),
        loadIuBudget(),
        loadHealth(),
      ]);
      const quota: UsageQuota =
        quotaResult.status === "fulfilled"
          ? quotaResult.value
          : { error: "Failed to load quota", fetched_at: 0 };

      if (spendResult.status === "fulfilled") {
        const spend = aggregateSpend(spendResult.value);
        const spendFetchedAt = Date.now();
        lastSpendRef.current = { spend, fetchedAt: spendFetchedAt };
        return { quota, spend, spendFetchedAt, spendError: null, iu, health };
      }
      return {
        quota,
        spend: lastSpendRef.current?.spend ?? null,
        spendFetchedAt: lastSpendRef.current?.fetchedAt,
        spendError: spendResult.reason,
        iu,
        health,
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
          {data?.health &&
            problemRows(data.health.report)
              .filter((row) => parseFixCommand(row.fix))
              .map((row) => (
                <Action
                  key={`${row.machine}-${row.id}-${row.check}`}
                  title={`Re-Login: ${rowTitle(row)}`}
                  icon={Icon.Key}
                  onAction={() => startRelogin(row)}
                />
              ))}
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

async function startRelogin(row: HealthRow) {
  if (!launchRelogin(row.fix)) return;
  await showHUD("Login started, approve in the browser");
}

function renderMarkdown(
  data: UsageData | undefined,
  isLoading: boolean,
): string {
  if (!data) return "Loading…";
  const { quota, spend, spendFetchedAt, spendError, iu, health } = data;
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

  lines.push(...iuBudgetBlock(iu));

  if (health) lines.push(...healthMarkdown(health.report));

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

// The IU API cap over the rolling 30 days: the figure, the daily chart against
// the even per-day share, and where the money went.
function iuBudgetBlock(reading: IuBudgetReading): string[] {
  const unavailable = unavailableText(reading);
  if (reading.kind !== "ok")
    return ["## IU API · 30 days", "", `_${unavailable}_`, ""];

  const view = iuBudgetView(reading.data);
  const lines = [`## IU API · 30 days · ${usageLine(view)}`, ""];
  lines.push(
    `**${canSpendLine(view)}**`,
    ...[freesLine(view)].filter((l): l is string => l !== null),
    "",
  );
  lines.push(`![IU daily spend](${iuBudgetChart(view)})`, "");
  lines.push(
    view.freshness === "fresh" ? `_${ageLine(view)}_` : `**${ageLine(view)}**`,
    "",
  );
  if (view.data.topModels.length > 0) {
    lines.push("| Model | Spend | Share |", "|-|-|-|");
    for (const m of view.data.topModels) {
      const share = modelShare(view, m.usd);
      const label = m.label.replace(/[|\r\n]+/g, " ");
      lines.push(
        `| ${label} | ${usd0(m.usd)} | ${share === null ? "—" : `${share} %`} |`,
      );
    }
    lines.push("");
  }
  return lines;
}
