import {
  MenuBarExtra,
  Icon,
  Color,
  launchCommand,
  LaunchType,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { getQuota } from "./usage/quota";
import { getTimeseries, aggregateSpend } from "./usage/spend";
import {
  formatUtilization,
  formatRelativeReset,
  formatSpend,
} from "./usage/format";
import { isQuotaError, UsageQuota } from "./usage/types";
import { menuBarRing, toDataUri } from "./lib/svg";

async function loadUsage() {
  const [quota, timeseries] = await Promise.all([getQuota(), getTimeseries()]);
  return { quota, spend: aggregateSpend(timeseries) };
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
  const { data, isLoading, revalidate } = usePromise(loadUsage);

  return (
    <MenuBarExtra
      icon={data ? menuBarIcon(data.quota) : Icon.LineChart}
      // Compact: just the 5h number — native rendering costs real menu-bar
      // space now, and the ring icon already signals "roughly how full".
      // The dropdown below still spells out every quota in full.
      title={
        data && !isQuotaError(data.quota)
          ? formatUtilization(data.quota.five_hour)
          : undefined
      }
      isLoading={isLoading}
      tooltip="Claude Usage"
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

      {data && (
        <MenuBarExtra.Section title="Spend (today)">
          {Object.entries(data.spend.today).map(([lane, amount]) => (
            <MenuBarExtra.Item
              key={lane}
              title={`${lane}: ${formatSpend(amount)}`}
            />
          ))}
          <MenuBarExtra.Item
            title={`7d total: ${formatSpend(data.spend.sevenDayTotal)}`}
          />
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
