import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import {
  Action,
  ActionPanel,
  Detail,
  Form,
  Icon,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo } from "react";
import { collectBatterySnapshot } from "./battery/collect";
import { metricsImage, panelImage } from "./battery/heroes";
import { BatterySnapshot } from "./battery/types";
import {
  Stamped,
  freshnessBanner,
  stamped,
  updatingLine,
} from "./lib/freshness";

const execFileAsync = promisify(execFile);
const LIMIT_SCRIPT = `${homedir()}/SourceRoot/dotfiles/launcher/battery-limit.sh`;

async function runLimitScript(cap: number, days?: number): Promise<string> {
  const args = days ? [String(cap), String(days)] : [String(cap)];
  const { stdout, stderr } = await execFileAsync("/bin/bash", [
    LIMIT_SCRIPT,
    ...args,
  ]);
  return (stdout || stderr).trim();
}

// Shared by the quick-limit actions and the "Set Limit…" form — runs the
// script behind one fixed-title toast, with the script's own output (which
// already says what happened) as the toast message rather than the title.
async function applyLimit({
  cap,
  days,
}: {
  cap: number;
  days?: number;
}): Promise<void> {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Setting limit to ${cap}%…`,
  });
  try {
    const output = await runLimitScript(cap, days);
    toast.style = Toast.Style.Success;
    toast.title = "Limit set";
    toast.message = output || `${cap}%`;
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = "Failed to set limit";
    toast.message = String(e);
    throw e;
  }
}

// The effective charge cap right now — `batt` treats a disabled limit as
// unrestricted (100%).
function currentCapPercent(status: BatterySnapshot["status"]): number {
  return status.configuration.enabled
    ? status.configuration.upperLimitPercent
    : 100;
}

function renderMarkdown(
  data: Stamped<BatterySnapshot> | undefined,
  error: unknown,
  isLoading: boolean,
): string {
  if (!data) return "Loading…";
  const snapshot = data.data;
  const lines = ["# Battery"];
  const banner = freshnessBanner({
    fetchedAt: data.fetchedAt,
    error,
    offlineLabel: "Battery data unavailable",
  });
  if (banner) lines.push("", banner);
  lines.push("", `![Battery](${panelImage(snapshot)})`);

  // No Detail.Metadata sidebar: the panel carries charge, state, watts, limit,
  // health and cycles, the metrics row voltage, temperature and adapter —
  // every number once, so no table.
  lines.push("", `![Metrics](${metricsImage(snapshot)})`);
  if (snapshot.pauseUntilEpoch) {
    const until = new Date(snapshot.pauseUntilEpoch * 1000);
    lines.push(
      "",
      `_Daily auto-reset paused until ${until.toLocaleDateString("de-DE", { day: "numeric", month: "long" })}._`,
    );
  }

  // Kept last so it never shifts the hero images above.
  const updating = updatingLine({ fetchedAt: data.fetchedAt, isLoading });
  if (updating) lines.push("", updating);

  return lines.join("\n");
}

export default function Battery() {
  const { data, isLoading, error, revalidate } = useCachedPromise(
    () => stamped(collectBatterySnapshot),
    [],
    { keepPreviousData: true, onError: () => {} },
  );
  const { push } = useNavigation();

  async function quickLimit(cap: number) {
    try {
      await applyLimit({ cap });
      revalidate();
    } catch {
      // toast already reported the failure
    }
  }

  const currentCap = data ? currentCapPercent(data.data.status) : null;
  const markdown = useMemo(
    () => renderMarkdown(data, error, isLoading),
    [data, error, isLoading],
  );

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action
            title="Set Limit…"
            icon={Icon.Gauge}
            onAction={() => push(<SetLimitForm onDone={revalidate} />)}
          />
          {currentCap !== 80 && (
            <Action
              title="Limit 80%"
              icon={Icon.Minus}
              onAction={() => quickLimit(80)}
            />
          )}
          {currentCap !== 100 && (
            <Action
              title="Charge to 100%"
              icon={Icon.Plus}
              onAction={() => quickLimit(100)}
            />
          )}
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={revalidate}
          />
        </ActionPanel>
      }
    />
  );
}

function SetLimitForm({ onDone }: { onDone: () => void }) {
  const { pop } = useNavigation();

  async function handleSubmit(values: { cap: string; days: string }) {
    const cap = Number(values.cap);
    if (!Number.isInteger(cap) || cap < 10 || cap > 100) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Cap must be a whole number from 10 to 100",
      });
      return;
    }
    const days = values.days.trim() ? Number(values.days.trim()) : undefined;
    try {
      await applyLimit({ cap, days });
      onDone();
      pop();
    } catch {
      // toast already reported the failure
    }
  }

  return (
    <Form
      navigationTitle="Set Battery Limit"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Set Limit" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="cap"
        title="Charge Cap %"
        defaultValue="80"
        placeholder="10-100"
        autoFocus
      />
      <Form.TextField
        id="days"
        title="Pause Auto-Reset (days)"
        placeholder="optional — blank clears any existing pause"
      />
      <Form.Description text="Runs launcher/battery-limit.sh — the daily 09:00 job resets to 80% unless paused." />
    </Form>
  );
}
