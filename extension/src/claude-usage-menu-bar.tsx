import { MenuBarExtra, Icon, launchCommand, LaunchType } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { getQuota } from "./usage/quota";
import { getTimeseries, aggregateSpend } from "./usage/spend";
import {
  formatUtilization,
  formatRelativeReset,
  formatSpend,
  menuBarTitle,
} from "./usage/format";
import { isQuotaError } from "./usage/types";

async function loadUsage() {
  const [quota, timeseries] = await Promise.all([getQuota(), getTimeseries()]);
  return { quota, spend: aggregateSpend(timeseries) };
}

export default function ClaudeUsageMenuBar() {
  const { data, isLoading, revalidate } = usePromise(loadUsage);

  return (
    <MenuBarExtra
      icon={Icon.LineChart}
      title={data ? menuBarTitle(data.quota) : undefined}
      isLoading={isLoading}
      tooltip="Claude Usage"
    >
      {data && !isQuotaError(data.quota) && (
        <MenuBarExtra.Section title="Quota">
          <MenuBarExtra.Item
            title={`5h: ${formatUtilization(data.quota.five_hour)} — resets ${formatRelativeReset(data.quota.five_hour.resets_at_epoch)}`}
          />
          <MenuBarExtra.Item
            title={`7d: ${formatUtilization(data.quota.seven_day)} — resets ${formatRelativeReset(data.quota.seven_day.resets_at_epoch)}`}
          />
          <MenuBarExtra.Item
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
