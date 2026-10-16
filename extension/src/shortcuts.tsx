import {
  Action,
  ActionPanel,
  Icon,
  Image,
  Keyboard,
  List,
  Toast,
  closeMainWindow,
  showToast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo } from "react";
import {
  ShortcutRow,
  RowIcon,
  shortcutSections,
  shortcutsMarkdown,
} from "./shortcuts/format";
import { launchTarget, loadShortcuts } from "./shortcuts/load";

function rowIcon(icon: RowIcon): Image.ImageLike {
  switch (icon.kind) {
    case "app":
      return { fileIcon: icon.path };
    case "asset":
      return icon.file;
    case "fallback":
      return Icon.AppWindow;
  }
}

async function launch(row: ShortcutRow) {
  if (!row.launch) return;
  try {
    await launchTarget(row.launch);
    if (row.launch.kind === "app") await closeMainWindow();
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: `Could not open ${row.title}`,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function Shortcuts() {
  const { data, isLoading, error, revalidate } = useCachedPromise(
    loadShortcuts,
    [],
    { keepPreviousData: true, onError: () => {} },
  );

  const sections = useMemo(() => (data ? shortcutSections(data) : []), [data]);
  const markdown = useMemo(() => (data ? shortcutsMarkdown(data) : ""), [data]);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search by name or key">
      {!data && error ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Could not read Tinycast's settings"
          description={error.message}
        />
      ) : null}
      {sections.map((section) => (
        <List.Section
          key={section.title}
          title={section.title}
          subtitle={section.subtitle}
        >
          {section.rows.map((row) => (
            <List.Item
              key={row.id}
              title={row.title}
              icon={rowIcon(row.icon)}
              keywords={row.keywords}
              accessories={row.key ? [{ tag: row.key }] : []}
              actions={
                <ActionPanel>
                  {row.launch ? (
                    <Action
                      title="Open"
                      icon={Icon.ArrowRight}
                      onAction={() => launch(row)}
                    />
                  ) : null}
                  <Action.CopyToClipboard
                    title="Copy as Markdown"
                    content={markdown}
                  />
                  <Action
                    title="Refresh"
                    icon={Icon.ArrowClockwise}
                    shortcut={Keyboard.Shortcut.Common.Refresh}
                    onAction={revalidate}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}
