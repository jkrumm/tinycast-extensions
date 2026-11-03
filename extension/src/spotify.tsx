import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  Keyboard,
  Toast,
  showToast,
} from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "./home/format";
import { SpotifyAction, perform } from "./spotify/actions";
import { isPlaying, stateMarkdown } from "./spotify/parse";
import { audio, readCached, writeCached } from "./spotify/run";
import { SpotifyState } from "./spotify/types";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const VOLUMES = [20, 40, 60, 80];

export default function Spotify() {
  const [state, setState] = useState<SpotifyState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Calls take 1–2 s; the newest answer wins.
  const latest = useRef(0);

  const settle = useCallback(
    async (task: () => Promise<SpotifyState>, failure: string) => {
      const ticket = ++latest.current;
      setIsLoading(true);
      try {
        const next = await task();
        if (ticket !== latest.current) return;
        setState(next);
        await writeCached(next);
      } catch (error) {
        await showToast({
          style: Toast.Style.Failure,
          title: failure,
          message: friendlyError(messageOf(error)),
        });
      } finally {
        if (ticket === latest.current) setIsLoading(false);
      }
    },
    [],
  );

  const refresh = useCallback(
    () => settle(() => audio(["now"]), "Could not read Spotify"),
    [settle],
  );

  useEffect(() => {
    let live = true;
    readCached()
      .then((stored) => {
        if (live && stored) setState((current) => current ?? stored);
      })
      .then(refresh);
    return () => {
      live = false;
    };
  }, [refresh]);

  const act = (action: SpotifyAction, failure: string) => () =>
    settle(() => perform(action), failure);

  return (
    <Detail
      navigationTitle="Spotify on Mine"
      isLoading={isLoading}
      markdown={stateMarkdown(state)}
      actions={
        <ActionPanel>
          <Action
            title={state && isPlaying(state) ? "Pause" : "Play"}
            icon={state && isPlaying(state) ? Icon.Pause : Icon.Play}
            onAction={act("toggle", "Could not play or pause")}
          />
          <Action
            title="Next"
            icon={Icon.Forward}
            shortcut={{ modifiers: ["cmd"], key: "]" }}
            onAction={act("next", "Could not skip")}
          />
          <Action
            title="Previous"
            icon={Icon.Rewind}
            shortcut={{ modifiers: ["cmd"], key: "[" }}
            onAction={act("previous", "Could not go back")}
          />
          <ActionPanel.Section title="Volume">
            <Action
              title="Louder"
              icon={Icon.SpeakerUp}
              shortcut={{ modifiers: ["cmd"], key: "u" }}
              onAction={act("louder", "Could not change the volume")}
            />
            <Action
              title="Quieter"
              icon={Icon.SpeakerDown}
              shortcut={{ modifiers: ["cmd"], key: "d" }}
              onAction={act("quieter", "Could not change the volume")}
            />
            <Action
              title="Much Quieter"
              icon={Icon.SpeakerDown}
              shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
              onAction={act("muchQuieter", "Could not change the volume")}
            />
            <ActionPanel.Submenu title="Set Volume" icon={Icon.SpeakerOn}>
              {VOLUMES.map((volume) => (
                <Action
                  key={volume}
                  title={`${volume} %`}
                  onAction={act(
                    { volume: String(volume) },
                    "Could not change the volume",
                  )}
                />
              ))}
            </ActionPanel.Submenu>
          </ActionPanel.Section>
          <ActionPanel.Section title="Device">
            <Action
              title="Play on Mine"
              icon={Icon.Speaker}
              shortcut={{ modifiers: ["cmd"], key: "m" }}
              onAction={act("take", "Could not play on Mine")}
            />
            <Action
              title="Play on MacBook"
              icon={Icon.Desktop}
              shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
              onAction={act("macbook", "Could not play on the MacBook")}
            />
          </ActionPanel.Section>
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={refresh}
          />
        </ActionPanel>
      }
    />
  );
}
