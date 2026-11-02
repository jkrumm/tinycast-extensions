import {
  Action,
  ActionPanel,
  Color,
  Icon,
  Keyboard,
  List,
  Toast,
  showToast,
} from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import {
  AttentionRow,
  attentionRows,
  friendlyError,
  sceneSubtitle,
} from "./home/format";
import { localStorageHome, refreshHome, triggerScene } from "./home/run";
import { HomeCache, Scene } from "./home/types";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function trigger(scene: Scene) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Triggering ${scene.name}`,
  });
  try {
    await triggerScene(scene.id);
    toast.style = Toast.Style.Success;
    toast.title = `${scene.name} triggered`;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = `Could not trigger ${scene.name}`;
    toast.message = friendlyError(messageOf(error));
  }
}

// Stale-while-revalidate: the LocalStorage copy renders first, then one
// `home scenes` + `home doctor` round trip replaces it.
function useHome() {
  const [cache, setCache] = useState<HomeCache | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      setCache(await refreshHome());
      setError(null);
    } catch (e) {
      const message = friendlyError(messageOf(e));
      setError(message);
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not refresh Home",
        message,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    localStorageHome
      .read()
      .catch(() => null)
      .then((stored) => {
        if (live && stored) setCache((current) => current ?? stored);
      })
      .then(refresh);
    return () => {
      live = false;
    };
  }, [refresh]);

  return { cache, isLoading, error, refresh };
}

function RefreshAction({ onRefresh }: { onRefresh: () => void }) {
  return (
    <Action
      title="Refresh"
      icon={Icon.ArrowClockwise}
      shortcut={Keyboard.Shortcut.Common.Refresh}
      onAction={onRefresh}
    />
  );
}

function AttentionItem({
  row,
  onRefresh,
}: {
  row: AttentionRow;
  onRefresh: () => void;
}) {
  const unreachable = row.kind === "unreachable";
  return (
    <List.Item
      title={row.title}
      subtitle={row.subtitle}
      icon={{
        source: unreachable ? Icon.Warning : Icon.Gauge,
        tintColor: unreachable ? Color.Red : Color.Orange,
      }}
      accessories={[{ tag: row.tag }]}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Details" content={row.copy} />
          <RefreshAction onRefresh={onRefresh} />
        </ActionPanel>
      }
    />
  );
}

export default function Home() {
  const { cache, isLoading, error, refresh } = useHome();
  const attention = attentionRows(cache?.doctor ?? null);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Trigger a scene">
      {!cache && error ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Could not reach Home"
          description={error}
          actions={
            <ActionPanel>
              <RefreshAction onRefresh={refresh} />
            </ActionPanel>
          }
        />
      ) : null}
      {cache ? (
        <List.Section title="Scenes">
          {cache.scenes.map((scene) => (
            <List.Item
              key={scene.id}
              title={scene.name}
              subtitle={sceneSubtitle(scene)}
              icon={Icon.Play}
              actions={
                <ActionPanel>
                  <Action
                    title="Trigger Scene"
                    icon={Icon.Play}
                    onAction={() => trigger(scene)}
                  />
                  <RefreshAction onRefresh={refresh} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
      {attention.length > 0 ? (
        <List.Section title="Needs attention">
          {attention.map((row) => (
            <AttentionItem key={row.id} row={row} onRefresh={refresh} />
          ))}
        </List.Section>
      ) : null}
    </List>
  );
}
