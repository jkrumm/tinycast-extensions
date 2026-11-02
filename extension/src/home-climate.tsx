import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  Keyboard,
  Toast,
  showToast,
} from "@raycast/api";
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
    {
      keepPreviousData: true,
      // The previous range stays on screen with its own label.
      onError: async (e) => {
        await showToast({
          style: Toast.Style.Failure,
          title: "Could not load the climate history",
          message: friendlyError(e.message),
        });
      },
    },
  );
  const body = data
    ? climateMarkdown({
        status: data.status,
        points: data.points,
        range: data.range,
        now: data.at,
      })
    : "# Climate history";
  const warning = error
    ? `> ⚠️ ${friendlyError(error.message)}${data ? ` — showing the last ${rangeLabel(data.range)}` : ""}\n\n`
    : "";
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
                icon={
                  r === (data?.range ?? range) ? Icon.CheckCircle : Icon.Circle
                }
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
