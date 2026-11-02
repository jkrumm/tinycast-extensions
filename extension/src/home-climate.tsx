import { Action, ActionPanel, Detail, Icon, Keyboard } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { climateHistoryMarkdown } from "./home/climate";
import { friendlyError } from "./home/format";
import { fetchClimate } from "./home/run";

export default function HomeClimate() {
  const { data, isLoading, error, revalidate } = useCachedPromise(
    async () => ({ points: await fetchClimate(), at: Date.now() }),
    [],
    { keepPreviousData: true, onError: () => {} },
  );
  const markdown = data
    ? climateHistoryMarkdown(data.points, data.at)
    : error
      ? `# Climate history\n\n${friendlyError(error.message)}`
      : "# Climate history";
  return (
    <Detail
      isLoading={isLoading}
      markdown={
        error && data
          ? `> ⚠️ ${friendlyError(error.message)}\n\n${markdown}`
          : markdown
      }
      actions={
        <ActionPanel>
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
