import { useEffect, useMemo, useRef, useState } from "react";
import { Detail } from "@raycast/api";
import { describeNetgearError } from "./errors";
import { runPing } from "./ping";
import { getClient } from "./session";
import {
  EMPTY_HISTORY,
  SignalHistory,
  pushSample,
  signalMarkdown,
  toSample,
} from "./signal-view";

// A live radio meter for finding the router's best spot: read-only (a guest GET
// of the model plus a short ping), session-only state, nothing persisted.
const TICK_MS = 2_000;

export function SignalMeter() {
  const [history, setHistory] = useState<SignalHistory>(EMPTY_HISTORY);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    let mounted = true;

    // A tick takes ~1-3 s (the ping), so a slow one is skipped over, never
    // stacked: the next interval fires while this one is still running.
    async function tick() {
      if (running.current) return;
      running.current = true;
      try {
        const client = await getClient();
        const [read, ping] = await Promise.all([
          client.getStatus().then(
            (status) => ({ status }),
            (failure: unknown) => ({ failure }),
          ),
          runPing(),
        ]);
        if (!mounted) return;
        if ("failure" in read) {
          setError(describeNetgearError(read.failure));
          return;
        }
        setHistory((h) =>
          pushSample(h, toSample(read.status, ping, Date.now())),
        );
        setError(null);
      } catch (e) {
        if (mounted) setError(describeNetgearError(e));
      } finally {
        running.current = false;
      }
    }

    tick();
    const id = setInterval(tick, TICK_MS);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const markdown = useMemo(
    () => signalMarkdown({ history, error }),
    [history, error],
  );

  return (
    <Detail
      navigationTitle="Signal Meter"
      isLoading={history.samples.length === 0 && !error}
      markdown={markdown}
    />
  );
}
