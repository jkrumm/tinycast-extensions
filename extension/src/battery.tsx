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
import { usePromise } from "@raycast/utils";
import { collectBatterySnapshot } from "./battery/collect";
import { batteryHealthPercent } from "./battery/parse";
import { BatterySnapshot } from "./battery/types";
import { batteryGlyph, thresholdBar, toDataUri } from "./lib/svg";

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

function heroImages(snapshot: BatterySnapshot): string[] {
  const { status, hardware } = snapshot;
  const glyph = batteryGlyph({
    percent: status.battery.currentChargePercent,
    limitPercent: status.configuration.enabled
      ? status.configuration.upperLimitPercent
      : undefined,
    charging: status.battery.state === "charging",
    wattsLabel: `${status.battery.chargeRateWatts.toFixed(1)} W`,
  });

  const images = [toDataUri(glyph)];
  if (hardware) {
    const health = batteryHealthPercent(hardware);
    images.push(
      toDataUri(
        thresholdBar({
          label: "Health",
          percent: health,
          valueText: `${health}% · ${hardware.cycleCount} cycles`,
          invert: true,
        }),
      ),
    );
  }
  return images;
}

function stateLabel(state: string): string {
  switch (state) {
    case "charging":
      return "Charging";
    case "discharging":
      return "Discharging";
    default:
      return state;
  }
}

function adapterLabel(status: BatterySnapshot["status"]): string {
  if (!status.charging.pluggedIn) return "Not connected";
  return status.charging.useAdapter
    ? "Connected, charging allowed"
    : "Connected, charging blocked";
}

function renderMarkdown(snapshot: BatterySnapshot | undefined): string {
  if (!snapshot) return "Loading…";
  const { status, hardware } = snapshot;
  const [glyph, health] = heroImages(snapshot);
  const lines = ["# Battery", "", `![Battery](${glyph})`];
  if (health) lines.push("", `![Health](${health})`);
  if (snapshot.pauseUntilEpoch) {
    const until = new Date(snapshot.pauseUntilEpoch * 1000);
    lines.push(
      "",
      `_Daily auto-reset paused until ${until.toLocaleDateString("de-DE", { day: "numeric", month: "long" })}._`,
    );
  }

  // No Detail.Metadata sidebar — the glyph + health bar above already carry
  // charge/limit/health/cycles; a table covers what's left (state, rate,
  // voltage, adapter, plus the hardware fields when ioreg parsed cleanly).
  lines.push(
    "",
    "| | |",
    "|-|-|",
    `| State | ${stateLabel(status.battery.state)} |`,
    `| Charge rate | ${status.battery.chargeRateWatts.toFixed(1)} W |`,
    `| Voltage | ${status.battery.voltageVolts.toFixed(2)} V |`,
    `| Adapter | ${adapterLabel(status)} |`,
  );
  if (hardware) {
    lines.push(
      `| Temperature | ${hardware.temperatureCelsius.toFixed(1)} °C |`,
    );
  }

  return lines.join("\n");
}

export default function Battery() {
  const { data, isLoading, revalidate } = usePromise(collectBatterySnapshot);
  const { push } = useNavigation();

  async function quickLimit(cap: number) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Setting limit to ${cap}%…`,
    });
    try {
      const output = await runLimitScript(cap);
      toast.style = Toast.Style.Success;
      toast.title = output || `Limit set to ${cap}%`;
      revalidate();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to set limit";
      toast.message = String(e);
    }
  }

  return (
    <Detail
      isLoading={isLoading}
      markdown={renderMarkdown(data)}
      actions={
        <ActionPanel>
          <Action
            title="Set Limit…"
            icon={Icon.Gauge}
            onAction={() => push(<SetLimitForm onDone={revalidate} />)}
          />
          <Action
            title="Limit 80%"
            icon={Icon.Minus}
            onAction={() => quickLimit(80)}
          />
          <Action
            title="Charge to 100%"
            icon={Icon.Plus}
            onAction={() => quickLimit(100)}
          />
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
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
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Setting limit to ${cap}%…`,
    });
    try {
      const output = await runLimitScript(cap, days);
      toast.style = Toast.Style.Success;
      toast.title = output || `Limit set to ${cap}%`;
      onDone();
      pop();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to set limit";
      toast.message = String(e);
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
