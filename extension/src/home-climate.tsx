import { Action, ActionPanel, Detail, Icon, Keyboard } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  CLIMATE_RANGES,
  ClimateRange,
  DEFAULT_RANGE,
  rangeLabel,
} from "./home/climate";
import { climateMarkdown } from "./home/climate-view";
import { friendlyError } from "./home/format";
import { loadClimate } from "./home/run";

export default function HomeClimate() {
  const [range, setRange] = useState<ClimateRange>(DEFAULT_RANGE);
  const { data, isLoading, error, revalidate } = useCachedPromise(
    (r: ClimateRange) => loadClimate(r),
    [range],
    { keepPreviousData: true, onError: () => {} },
  );
  const body = data
    ? climateMarkdown({
        status: data.status,
        points: data.points,
        range,
        now: data.at,
      })
    : "# Climate history";
  const warning = error ? `> ⚠️ ${friendlyError(error.message)}\n\n` : "";
  return (
    <Detail
      isLoading={isLoading}
      markdown={`${warning}${body}`}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Range">
            {CLIMATE_RANGES.map((r, i) => (
              <Action
                key={r}
                title={`Last ${rangeLabel(r)}`}
                icon={r === range ? Icon.CheckCircle : Icon.Circle}
                shortcut={{ modifiers: ["cmd"], key: String(i + 1) as "1" }}
                onAction={() => setRange(r)}
              />
            ))}
          </ActionPanel.Section>
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={revalidate}
          />
        </ActionPanel>
      }
    />
  );
}
