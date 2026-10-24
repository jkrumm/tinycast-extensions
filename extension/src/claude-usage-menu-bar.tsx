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
  STALE_HINT_SECONDS,
  accountFlags,
  accountSummary,
  flagText,
} from "./usage/accounts";
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
import { QuotaWindow, quotaLimits, weeklyPace } from "./usage/limits";
import {
  isQuotaError,
  UsageQuota,
  UsageQuotaOk,
  AccountQuota,
  SpendAggregate,
} from "./usage/types";
import { menuBarRing, toDataUri } from "./lib/svg";

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

// A live ring reflecting the weekly quota — the limit that binds on a Max
// plan. Native menu-bar rendering (beta) fits this into an 18×18pt
// NSStatusItem glyph, so no text: the ring's fill is the whole signal.
function menuBarIcon(quota: UsageQuota): string {
  const percent = isQuotaError(quota)
    ? 0
    : (quotaLimits(quota).weekly.percent ?? 0);
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

export default function ClaudeUsageMenuBar() {
  const { data, isLoading, revalidate } = useUsage();

  const icon = useMemo(
    () => (data ? menuBarIcon(data.quota) : Icon.LineChart),
    [data],
  );

  const quotaStale =
    !!data && !isQuotaError(data.quota) && isStaleHint(data.quota.fetched_at);

  return (
    <MenuBarExtra
      icon={icon}
      // Compact: the bare weekly percent ("14%"), matching the ring. The
      // dropdown spells out every limit.
      title={
        data && !isQuotaError(data.quota)
          ? menuBarTitleWithFreshness(data.quota, quotaStale)
          : undefined
      }
      isLoading={isLoading}
      tooltip={`Claude Usage${quotaStale ? " (stale)" : ""}`}
    >
      {data &&
        !isQuotaError(data.quota) &&
        (data.quota.accounts?.length ?? 0) > 1 && (
          <AccountsSection accounts={data.quota.accounts!} />
        )}

      {data && !isQuotaError(data.quota) && <QuotaSection quota={data.quota} />}

      {data && isQuotaError(data.quota) && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title={`⚠ ${data.quota.error}`} />
        </MenuBarExtra.Section>
      )}

      {data && data.spend && (
        <MenuBarExtra.Section
          title={
            data.spendError ? "Spend (today, last known)" : "Spend (today)"
          }
        >
          {topLanesWithOther(data.spend.today, SPEND_LANE_LIMIT).map(
            ({ label, value }) => (
              <MenuBarExtra.Item
                key={label}
                title={`${label}: ${formatSpend(value)}`}
              />
            ),
          )}
          <MenuBarExtra.Item
            title={`7d total: ${formatSpend(data.spend.sevenDayTotal)}`}
          />
        </MenuBarExtra.Section>
      )}

      {data && data.spendError && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title={data.spendError} />
        </MenuBarExtra.Section>
      )}

      <MenuBarExtra.Section>
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

function AccountsSection({ accounts }: { accounts: AccountQuota[] }) {
  return (
    <MenuBarExtra.Section title="Accounts">
      {accounts.map((a) => {
        const flags = accountFlags(a, STALE_HINT_SECONDS)
          .map(flagText)
          .join(", ");
        return (
          <MenuBarExtra.Item
            key={a.id}
            icon={{
              source: Icon.Circle,
              tintColor: dotColor(a.sevenDayPct),
            }}
            title={`${a.id}${a.plan ? ` (${a.plan})` : ""}: ${accountSummary(a)}${flags ? ` — ${flags}` : ""}`}
          />
        );
      })}
      {accounts.map((a) => (
        <MenuBarExtra.Item
          key={`${a.id}-reset`}
          title={`${a.id} resets: 5h ${formatRelativeReset(a.fiveHourResetsAt)} · 7d ${a.sevenDayResetsAt === null ? "—" : formatWeekdayTime(a.sevenDayResetsAt)}`}
        />
      ))}
    </MenuBarExtra.Section>
  );
}

function QuotaSection({ quota }: { quota: UsageQuotaOk }) {
  const { weekly, session, models } = quotaLimits(quota);
  const pace = weeklyPace(weekly, Date.now() / 1000);
  return (
    <MenuBarExtra.Section
      title={quota.accounts?.[0] ? `Quota — ${quota.accounts[0].id}` : "Quota"}
    >
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
      <MenuBarExtra.Item
        title={`Updated ${formatClock(quota.fetched_at)}${isStaleHint(quota.fetched_at) ? " (stale)" : ""}`}
      />
    </MenuBarExtra.Section>
  );
}
