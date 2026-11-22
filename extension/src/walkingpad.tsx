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
import { WalkingPadAction, perform } from "./walkingpad/actions";
import { describeError } from "./walkingpad/client";
import {
  SPEED_PRESETS,
  formatSpeed,
  phaseOf,
  statusMarkdown,
} from "./walkingpad/parse";
import { Connection, connect, readCached, writeCached } from "./walkingpad/run";
import { PadStatus } from "./walkingpad/types";

// A walk in progress ticks; poll while the view is open. A read is ~100 ms.
const POLL_MS = 3_000;

export default function WalkingPad() {
  const [status, setStatus] = useState<PadStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const connection = useRef<Promise<Connection> | null>(null);
  // A rejected connect() (config unreadable, Keychain denied) is kept, so the
  // 3 s poll does not respawn `security` and re-show its dialog; Refresh and
  // the actions ask again.
  const connectFailed = useRef(false);
  // The newest answer wins; a command in flight pauses polling.
  const latest = useRef(0);
  const busy = useRef(false);

  const getConnection = () =>
    (connection.current ??= connect().catch((e: unknown) => {
      connectFailed.current = true;
      throw e;
    }));

  const retryConnect = () => {
    if (!connectFailed.current) return;
    connectFailed.current = false;
    connection.current = null;
  };

  const read = useCallback(async () => {
    if (busy.current) return;
    const ticket = ++latest.current;
    try {
      const { client } = await getConnection();
      const next = await client.status();
      if (ticket !== latest.current) return;
      setStatus(next);
      setError(null);
      await writeCached(next);
    } catch (e) {
      if (ticket === latest.current) setError(describeError(e));
    } finally {
      if (ticket === latest.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    readCached()
      .then((cached) => {
        if (live && cached) setStatus((current) => current ?? cached.status);
      })
      .then(read);
    const timer = setInterval(read, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [read]);

  const act = (action: WalkingPadAction) => async () => {
    busy.current = true;
    setIsLoading(true);
    retryConnect();
    try {
      const { client, startSpeed } = await getConnection();
      const outcome = await perform(action, client, startSpeed);
      await showToast({ style: Toast.Style.Success, title: outcome.message });
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "WalkingPad",
        message: describeError(e),
      });
    } finally {
      busy.current = false;
      await read();
    }
  };

  const moving =
    status !== null &&
    (phaseOf(status) === "active" || phaseOf(status) === "starting");

  return (
    <Detail
      navigationTitle="WalkingPad"
      isLoading={isLoading}
      markdown={
        error && !status
          ? `# WalkingPad\n\n${error}`
          : `${statusMarkdown(status)}${error ? `\n\n_${error}_` : ""}`
      }
      actions={
        <ActionPanel>
          <Action
            title={moving ? "Stop" : "Start"}
            icon={moving ? Icon.Stop : Icon.Play}
            onAction={act("toggle")}
          />
          <Action
            title="Faster"
            icon={Icon.ArrowUp}
            shortcut={{ modifiers: ["cmd"], key: "=" }}
            onAction={act("faster")}
          />
          <Action
            title="Slower"
            icon={Icon.ArrowDown}
            shortcut={{ modifiers: ["cmd"], key: "-" }}
            onAction={act("slower")}
          />
          <ActionPanel.Section title="Speed">
            {SPEED_PRESETS.map((speed, index) => (
              <Action
                key={speed}
                title={formatSpeed(speed)}
                icon={Icon.Gauge}
                shortcut={{
                  modifiers: ["cmd"],
                  key: String(index + 1) as Keyboard.KeyEquivalent,
                }}
                onAction={act({ speed })}
              />
            ))}
          </ActionPanel.Section>
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={() => {
              retryConnect();
              return read();
            }}
          />
        </ActionPanel>
      }
    />
  );
}
