import {
  MenuBarExtra,
  Icon,
  Color,
  launchCommand,
  LaunchType,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo, useRef } from "react";
import { getQuota, isStaleHint } from "./usage/quota";
import {
  getTimeseries,
  aggregateSpend,
  topLanesWithOther,
} from "./usage/spend";
import {
  formatPace,
  formatPercent,
  formatRelativeReset,
  formatSpend,
  formatWeekdayTime,
  menuBarTitleWithFreshness,
  modelLimitLabel,
  spendErrorText,
} from "./usage/format";
import { laneLines, missingSideNote } from "./usage/routing-text";
import { divergences } from "./usage/routing";
import {
  AccountSummary,
  UsageSummary,
  accountProblem,
  laneLabel,
  menuBarTitle,
  paceWords,
  summarize,
} from "./usage/summary";
import { QuotaWindow, quotaLimits, weeklyPace } from "./usage/limits";
import {
  hasMultipleAccounts,
  isQuotaError,
  UsageQuota,
  UsageQuotaOk,
  SpendAggregate,
} from "./usage/types";
import { menuBarRing, toDataUri } from "./lib/svg";
import { RoutingView } from "./usage/routing";

// Matches the detail view's cap (5 lanes + "other") — argo tracks ~60 lanes,
// almost all zero on a given day.
const SPEND_LANE_LIMIT = 5;

// Tinycast only stores a menu-bar render once nothing is loading, and kills a
// run after 60 s — a hanging argo request (flaky mobile internet) would
// otherwise keep the quota title from ever updating. Runs in parallel with
// the quota fetch (20 s cap), so this fits the deadline with room to spare.
const SPEND_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Same split as claude-usage.tsx: getQuota() never rejects, getTimeseries()
// can — spend keeps its last-good value + a spendError line so a failing
// spend fetch doesn't blank out a working quota reading. The error is kept
// as text: the result is persisted as JSON, an Error would come back as {}.
function useUsage() {
  const lastSpendRef = useRef<SpendAggregate | undefined>(undefined);

  return useCachedPromise(
    async () => {
      const [quotaResult, spendResult] = await Promise.allSettled([
        getQuota(),
        withTimeout(getTimeseries("7d"), SPEND_TIMEOUT_MS),
      ]);
      const quota: UsageQuota =
        quotaResult.status === "fulfilled"
          ? quotaResult.value
          : { error: "Failed to load quota", fetched_at: 0 };

      if (spendResult.status === "fulfilled") {
        lastSpendRef.current = aggregateSpend(spendResult.value);
        return { quota, spend: lastSpendRef.current, spendError: null };
      }
      return {
        quota,
        spend: lastSpendRef.current ?? null,
        spendError: spendErrorText(spendResult.reason),
      };
    },
    [],
    { keepPreviousData: true },
  );
}

// A live ring reflecting the pool's weekly use (the one account's weekly when
// there is only one) — the limit that binds on a Max plan. Native menu-bar rendering (beta) fits this into an 18×18pt
// NSStatusItem glyph, so no text: the ring's fill is the whole signal.
function menuBarIcon(quota: UsageQuota, summary: UsageSummary | null): string {
  const percent =
    summary?.pool?.usedPct ??
    (isQuotaError(quota) ? 0 : (quotaLimits(quota).weekly.percent ?? 0));
  return toDataUri(menuBarRing({ percent }));
}

function windowItem(label: string, window: QuotaWindow, reset: string) {
  return (
    <MenuBarExtra.Item
      key={label}
      icon={{ source: Icon.Circle, tintColor: dotColor(window.percent) }}
      title={`${label}: ${formatPercent(window.percent)} — ${reset}`}
    />
  );
}

function formatClock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function resetText(window: QuotaWindow): string {
  return `resets in ${formatRelativeReset(window.resetsAt)}`;
}

// UI (Color enum) counterpart of lib/svg's thresholdColor — same
// thresholds, different colour space.
function dotColor(percent: number | null): Color {
  if (percent === null) return Color.SecondaryText;
  if (percent < 50) return Color.Green;
  if (percent < 80) return Color.Orange;
  return Color.Red;
}

function summaryOf(quota: UsageQuota): UsageSummary | null {
  return hasMultipleAccounts(quota)
    ? summarize(quota.accounts, quota.routing)
    : null;
}

export default function ClaudeUsageMenuBar() {
  const { data, isLoading, revalidate } = useUsage();

  const summary = useMemo(() => (data ? summaryOf(data.quota) : null), [data]);
  const icon = useMemo(
    () => (data ? menuBarIcon(data.quota, summary) : Icon.LineChart),
    [data, summary],
  );

  const quotaStale =
    !!data && !isQuotaError(data.quota) && isStaleHint(data.quota.fetched_at);

  return (
    <MenuBarExtra
      icon={icon}
      // Several accounts: the account work goes to + its weekly use, with a
      // mark when something needs attention. One account: the bare weekly %.
      title={
        summary
          ? menuBarTitle(summary)
          : data && !isQuotaError(data.quota)
            ? menuBarTitleWithFreshness(data.quota, quotaStale)
            : undefined
      }
      isLoading={isLoading}
      tooltip={summary ? summary.headline : "Claude Usage"}
    >
      {data && summary && hasMultipleAccounts(data.quota) && (
        <>
          <MenuBarExtra.Section>
            <MenuBarExtra.Item
              icon={severityIcon(summary)}
              title={summary.headline}
            />
          </MenuBarExtra.Section>
          <AccountsSection accounts={summary.accounts} />
          <RoutingSection routing={data.quota.routing} />
        </>
      )}

      {data && !summary && !isQuotaError(data.quota) && (
        <QuotaSection quota={data.quota} />
      )}

      {data && isQuotaError(data.quota) && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title={`⚠ ${data.quota.error}`} />
        </MenuBarExtra.Section>
      )}

      {data && data.spend && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Submenu
            icon={Icon.Coins}
            title={`Spend ${formatSpend(data.spend.todayTotal)} today · ${formatSpend(data.spend.sevenDayTotal)} 7d${data.spendError ? " (last known)" : ""}`}
          >
            {topLanesWithOther(data.spend.today, SPEND_LANE_LIMIT).map(
              ({ label, value }) => (
                <MenuBarExtra.Item
                  key={label}
                  title={`${label}: ${formatSpend(value)}`}
                />
              ),
            )}
          </MenuBarExtra.Submenu>
        </MenuBarExtra.Section>
      )}

      {data && data.spendError && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title={data.spendError} />
        </MenuBarExtra.Section>
      )}

      <MenuBarExtra.Section>
        {data && !isQuotaError(data.quota) && (
          <MenuBarExtra.Item
            title={`Updated ${formatClock(data.quota.fetched_at)}${quotaStale ? " (stale)" : ""}`}
          />
        )}
        <MenuBarExtra.Item
          title="Open Details"
          icon={Icon.Sidebar}
          onAction={() =>
            launchCommand({
              name: "claude-usage",
              type: LaunchType.UserInitiated,
            })
          }
        />
        <MenuBarExtra.Item
          title="Refresh"
          icon={Icon.ArrowClockwise}
          onAction={revalidate}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}

function severityIcon(summary: UsageSummary) {
  const tint =
    summary.severity === "ok"
      ? Color.Green
      : summary.severity === "low"
        ? Color.Orange
        : Color.Red;
  return { source: Icon.Circle, tintColor: tint };
}

// One line per account: where its week stands and is heading, then its 5h
// window; a flag or the reason this Mac would not pick it comes last.
function accountLine(a: AccountSummary): string {
  const plan = a.plan ? ` ${a.plan}` : "";
  const week = `${formatPercent(a.weeklyPct)} week (${paceWords(a.pace, formatWeekdayTime)})`;
  const session = `5h ${formatPercent(a.fiveHourPct)} · ${formatRelativeReset(a.fiveHourResetsAt)}`;
  const problem =
    accountProblem(a) ??
    (a.eligibility.eligible ? null : `not pickable: ${a.eligibility.reason}`);
  return `${a.id}${plan} — ${week} · ${session}${problem ? ` — ${problem}` : ""}`;
}

function AccountsSection({ accounts }: { accounts: AccountSummary[] }) {
  return (
    <MenuBarExtra.Section title="Accounts">
      {accounts.map((a) => (
        <MenuBarExtra.Item
          key={a.id}
          icon={{
            source: Icon.Circle,
            tintColor:
              a.flags.length > 0 || !a.eligibility.eligible
                ? Color.SecondaryText
                : dotColor(a.weeklyPct),
          }}
          title={accountLine(a)}
        />
      ))}
    </MenuBarExtra.Section>
  );
}

// Where each kind of work goes and why, and where this Mac and the mini
// disagree.
function RoutingSection({ routing }: { routing: RoutingView | undefined }) {
  if (!routing) return null;
  const note = missingSideNote(routing);
  const diverging = divergences(routing, Date.now() / 1000, laneLabel);
  return (
    <MenuBarExtra.Section title="Routing">
      {laneLines(routing.picks).map((line) => (
        <MenuBarExtra.Item key={line} title={line} />
      ))}
      {diverging.map((d) => (
        <MenuBarExtra.Item key={d} title={`⚠ ${d}`} />
      ))}
      {routing.picks && routing.argoPicks && diverging.length === 0 && (
        <MenuBarExtra.Item title="Mini picks the same" />
      )}
      {note && <MenuBarExtra.Item title={note} />}
    </MenuBarExtra.Section>
  );
}

function QuotaSection({ quota }: { quota: UsageQuotaOk }) {
  const { weekly, session, models } = quotaLimits(quota);
  const pace = weeklyPace(weekly, Date.now() / 1000);
  return (
    <MenuBarExtra.Section title="Quota">
      {windowItem(
        "Weekly",
        weekly,
        weekly.resetsAt === null
          ? "no reset time"
          : `resets ${formatWeekdayTime(weekly.resetsAt)} (${formatRelativeReset(weekly.resetsAt)})`,
      )}
      {pace && <MenuBarExtra.Item title={`Pace: ${formatPace(pace)}`} />}
      {windowItem("5h session", session, resetText(session))}
      {models.map((model) =>
        windowItem(modelLimitLabel(model), model, resetText(model)),
      )}
    </MenuBarExtra.Section>
  );
}
