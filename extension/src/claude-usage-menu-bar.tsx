import {
  MenuBarExtra,
  Icon,
  Color,
  launchCommand,
  LaunchType,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo, useRef } from "react";
import { getQuota } from "./usage/quota";
import {
  getTimeseries,
  aggregateSpend,
  topLanesWithOther,
} from "./usage/spend";
import {
  formatUtilization,
  formatRelativeReset,
  formatSpend,
} from "./usage/format";
import { isQuotaError, UsageQuota, SpendAggregate } from "./usage/types";
import { menuBarRing, toDataUri } from "./lib/svg";

// Matches the detail view's cap (5 lanes + "other") — argo tracks ~60 lanes,
// almost all zero on a given day.
const SPEND_LANE_LIMIT = 5;

// Same split as claude-usage.tsx: getQuota() never rejects, getTimeseries()
// can — spend keeps its last-good value + a spendError flag so a failing
// spend fetch doesn't blank out a working quota reading.
function useUsage() {
  const lastSpendRef = useRef<SpendAggregate | undefined>(undefined);

  return useCachedPromise(
    async () => {
      const [quotaResult, spendResult] = await Promise.allSettled([
        getQuota(),
        getTimeseries(),
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
        spendError: spendResult.reason,
      };
    },
    [],
    { keepPreviousData: true },
  );
}

// A live ring reflecting the 5h quota — native menu-bar rendering (beta)
// fits this into an 18×18pt NSStatusItem glyph, so no text: the ring's fill
// is the whole signal.
function menuBarIcon(quota: UsageQuota): string {
  const percent = isQuotaError(quota) ? 0 : (quota.five_hour.utilization ?? 0);
  return toDataUri(menuBarRing({ percent }));
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

  const offline = !!(data && (isQuotaError(data.quota) || data.spendError));

  return (
    <MenuBarExtra
      icon={icon}
      // Compact: just the 5h number — native rendering costs real menu-bar
      // space now, and the ring icon already signals "roughly how full".
      // The dropdown below still spells out every quota in full.
      title={
        data && !isQuotaError(data.quota)
          ? `${formatUtilization(data.quota.five_hour)}${offline ? " (offline)" : ""}`
          : undefined
      }
      isLoading={isLoading}
      tooltip={`Claude Usage${offline ? " (offline)" : ""}`}
    >
      {data && !isQuotaError(data.quota) && (
        <MenuBarExtra.Section title="Quota">
          <MenuBarExtra.Item
            icon={{
              source: Icon.Circle,
              tintColor: dotColor(data.quota.five_hour.utilization),
            }}
            title={`5h: ${formatUtilization(data.quota.five_hour)} — resets ${formatRelativeReset(data.quota.five_hour.resets_at_epoch)}`}
          />
          <MenuBarExtra.Item
            icon={{
              source: Icon.Circle,
              tintColor: dotColor(data.quota.seven_day.utilization),
            }}
            title={`7d: ${formatUtilization(data.quota.seven_day)} — resets ${formatRelativeReset(data.quota.seven_day.resets_at_epoch)}`}
          />
          <MenuBarExtra.Item
            icon={{
              source: Icon.Circle,
              tintColor: dotColor(data.quota.seven_day_sonnet.utilization),
            }}
            title={`7d Sonnet: ${formatUtilization(data.quota.seven_day_sonnet)} — resets ${formatRelativeReset(data.quota.seven_day_sonnet.resets_at_epoch)}`}
          />
        </MenuBarExtra.Section>
      )}

      {data && isQuotaError(data.quota) && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title={`⚠ ${data.quota.error}`} />
        </MenuBarExtra.Section>
      )}

      {data && data.spend && (
        <MenuBarExtra.Section title="Spend (today)">
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

      {data && !data.spend && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title="Spend unavailable — argo request failed" />
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
