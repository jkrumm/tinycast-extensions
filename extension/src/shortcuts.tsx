import { Action, ActionPanel, Detail, Icon, Keyboard } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo } from "react";
import { shortcutsMarkdown } from "./shortcuts/format";
import { loadShortcuts } from "./shortcuts/load";

export default function Shortcuts() {
  const { data, isLoading, error, revalidate } = useCachedPromise(
    loadShortcuts,
    [],
    { keepPreviousData: true, onError: () => {} },
  );

  const markdown = useMemo(() => {
    if (data) return shortcutsMarkdown(data);
    if (error)
      return `# Shortcuts\n\nCould not read Tinycast's settings: ${error.message}`;
    return "Loading…";
  }, [data, error]);

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy as Markdown" content={markdown} />
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
