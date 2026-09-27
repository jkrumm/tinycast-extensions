import { useCallback } from "react";
import {
  Detail,
  ActionPanel,
  Action,
  Icon,
  Form,
  confirmAlert,
  Alert,
  showToast,
  Toast,
  openExtensionPreferences,
  environment,
  useNavigation,
  launchCommand,
  LaunchType,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { mkdir } from "fs/promises";
import { join } from "path";
import { prefs } from "./lib/argo";
import { getSecret, SecretUnavailableError } from "./lib/secrets";
import { CurlNetgearHttp } from "./netgear/transport";
import { NetgearClient } from "./netgear/client";
import { RouterStatus } from "./netgear/types";
import { batteryGlyph, ringGaugeRow, signalBars, toDataUri } from "./lib/svg";

const DEFAULT_HOST = "http://192.168.1.1";

async function getClient(): Promise<NetgearClient> {
  await mkdir(environment.supportPath, { recursive: true });
  const jarPath = join(environment.supportPath, "netgear-cookies.jar");
  const host = prefs().netgearHost?.replace(/\/$/, "") || DEFAULT_HOST;
  return new NetgearClient({ host, transport: new CurlNetgearHttp(jarPath) });
}

// Elevates to Admin automatically once a password is resolvable (override,
// Keychain, or 1Password) — Guest role otherwise, which still exposes
// read-only status. Silent on SecretUnavailableError: an unconfigured router
// password is a normal, quiet state on every background load, not a toast.
async function loadStatus(): Promise<RouterStatus> {
  const client = await getClient();
  const status = await client.getStatus();
  if (status.userRole === "Admin") return status;
  try {
    const password = await getSecret("netgearPassword", prefs());
    return await client.login(password);
  } catch (e) {
    if (e instanceof SecretUnavailableError) return status;
    throw e;
  }
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

// Radio quality reads differently from a quota percentage — LTE signal
// rarely climbs past 60-70% even on a strong connection, so the usual 50/80
// split reads a merely-good signal as red. 60/35 instead.
const RADIO_QUALITY_LOW = 35;
const RADIO_QUALITY_HIGH = 60;

function heroImages(status: RouterStatus): string[] {
  const signal = signalBars({
    percent: status.radioQuality,
    bars: 5,
    label: status.connectionText || status.connection,
  });

  const radioGauge = ringGaugeRow([
    {
      percent: status.radioQuality,
      label: "Radio Quality",
      sublabel: `${status.band || "—"} · ${status.operator || "no operator"}${status.roaming ? " (roaming)" : ""}`,
      invert: true,
      lowBoundary: RADIO_QUALITY_LOW,
      highBoundary: RADIO_QUALITY_HIGH,
    },
  ]);

  const battery = batteryGlyph({
    percent: status.battChargeLevel,
    charging: status.charging,
  });

  return [toDataUri(signal), toDataUri(radioGauge), toDataUri(battery)];
}

function statusMarkdown(status: RouterStatus): string {
  const [signal, radioGauge, battery] = heroImages(status);
  const lines = [
    `# ${status.connectionText || status.connection}`,
    "",
    `![Signal](${signal})`,
    "",
    `![Radio Quality](${radioGauge})`,
    "",
    `![Battery](${battery})`,
  ];
  if (status.simStatus !== "Ready") {
    lines.push(
      "",
      `⚠️ **SIM: ${status.simStatus}** — PIN retries left: ${status.simPinRetry}`,
    );
  }
  if (status.userRole !== "Admin") {
    lines.push(
      "",
      "_Guest session — set the Netgear Admin Password preference to unlock actions._",
    );
  }

  // No Detail.Metadata sidebar — the heroes above already carry signal,
  // band/operator, and battery %; a table covers what's left, now that
  // Tinycast beta renders markdown tables as a real grid.
  lines.push(
    "",
    "| | |",
    "|-|-|",
    `| Role | ${status.userRole} |`,
    `| Connection | ${status.connection} |`,
    `| Data transferred (cycle) | ${status.dataTransferredGB} GB |`,
    `| Uptime | ${formatUptime(status.uptimeSeconds)} |`,
    `| SIM | ${status.simStatus} |`,
  );
  if (status.connectedClients !== null) {
    lines.push(`| Connected clients | ${status.connectedClients} |`);
  }
  if (status.batteryTemperature !== null) {
    lines.push(`| Battery temp | ${status.batteryTemperature}°C |`);
  }
  lines.push(
    `| SMS | ${status.smsUnread > 0 ? `${status.smsUnread} unread` : status.smsReady ? "No unread" : "—"} |`,
  );

  return lines.join("\n");
}

async function requirePasswordOrToast(): Promise<string | null> {
  try {
    return await getSecret("netgearPassword", prefs());
  } catch (e) {
    await showToast({
      style: Toast.Style.Failure,
      title: "No admin password available",
      message: e instanceof Error ? e.message : String(e),
      primaryAction: {
        title: "Open Preferences",
        onAction: () => openExtensionPreferences(),
      },
    });
    return null;
  }
}

export default function Netgear() {
  const { data: status, isLoading, revalidate } = usePromise(loadStatus);
  const { push } = useNavigation();

  const runAction = useCallback(
    async (label: string, fn: (client: NetgearClient) => Promise<void>) => {
      const password = await requirePasswordOrToast();
      if (!password) return;
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: `${label}…`,
      });
      try {
        const client = await getClient();
        await client.login(password);
        await fn(client);
        toast.style = Toast.Style.Success;
        toast.title = `${label} done`;
        revalidate();
      } catch (e) {
        toast.style = Toast.Style.Failure;
        toast.title = `${label} failed`;
        toast.message = String(e);
      }
    },
    [revalidate],
  );

  async function confirmReboot() {
    const confirmed = await confirmAlert({
      title: "Reboot the router?",
      message: "The mobile connection drops for about a minute.",
      primaryAction: { title: "Reboot", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    await runAction("Reboot", (c) => c.reboot());
  }

  async function reconnect() {
    await runAction("Reconnect", async (c) => {
      await c.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await c.connect();
    });
  }

  return (
    <Detail
      isLoading={isLoading}
      markdown={status ? statusMarkdown(status) : "Loading…"}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              onAction={revalidate}
            />
            {status && status.simStatus !== "Ready" && (
              <Action
                title="Enter Sim Pin"
                icon={Icon.Lock}
                onAction={() => push(<EnterPinForm onDone={revalidate} />)}
              />
            )}
            {status && (
              <Action
                title="Connected Devices"
                icon={Icon.Devices}
                onAction={() => push(<ConnectedDevices status={status} />)}
              />
            )}
            {status && (
              <Action
                title="Sms"
                icon={Icon.SpeechBubble}
                onAction={() => push(<SmsInbox status={status} />)}
              />
            )}
          </ActionPanel.Section>
          <ActionPanel.Section title="Connection">
            <Action title="Reconnect" icon={Icon.Repeat} onAction={reconnect} />
            <Action
              title="Connect"
              icon={Icon.Play}
              onAction={() => runAction("Connect", (c) => c.connect())}
            />
            <Action
              title="Disconnect"
              icon={Icon.Stop}
              onAction={() => runAction("Disconnect", (c) => c.disconnect())}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action.OpenInBrowser
              title="Open Web Ui"
              url={prefs().netgearHost || DEFAULT_HOST}
            />
            <Action
              title="Run Speed Test"
              icon={Icon.Gauge}
              onAction={() =>
                launchCommand({
                  name: "speed-test",
                  type: LaunchType.UserInitiated,
                })
              }
            />
            <Action
              title="Open Extension Preferences"
              icon={Icon.Gear}
              onAction={() => openExtensionPreferences()}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Reboot"
              icon={Icon.Power}
              style={Action.Style.Destructive}
              onAction={confirmReboot}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function EnterPinForm({ onDone }: { onDone: () => void }) {
  const { pop } = useNavigation();

  async function handleSubmit(values: { pin: string }) {
    const password = await requirePasswordOrToast();
    if (!password) return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Entering PIN…",
    });
    try {
      const client = await getClient();
      await client.login(password);
      await client.enterSimPin(values.pin);
      toast.style = Toast.Style.Success;
      toast.title = "PIN accepted";
      onDone();
      pop();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "PIN rejected";
      toast.message = String(e);
    }
  }

  return (
    <Form
      navigationTitle="Enter SIM PIN"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Submit" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.PasswordField
        id="pin"
        title="SIM PIN"
        placeholder="4-8 digits"
        autoFocus
      />
      <Form.Description text="Never persisted — sent once to unlock the SIM." />
    </Form>
  );
}

function connectedDevicesMarkdown(status: RouterStatus): string {
  const lines = ["# Connected Devices", ""];
  if (status.connectedDevices.length === 0) {
    lines.push(
      "_No devices reported — the router's model.json had no client list._",
    );
    return lines.join("\n");
  }
  lines.push(
    "| Name | IP | Media | MAC |",
    "|-|-|-|-|",
    ...status.connectedDevices.map(
      (d) => `| ${d.name || "—"} | ${d.ip} | ${d.media} | ${d.mac} |`,
    ),
  );
  return lines.join("\n");
}

function ConnectedDevices({ status }: { status: RouterStatus }) {
  return (
    <Detail
      navigationTitle="Connected Devices"
      markdown={connectedDevicesMarkdown(status)}
    />
  );
}

// Read-only: model.json only ever exposes an unread count, never message
// bodies — no endpoint for the message list was found while exploring the
// live device (see docs/netgear-m2.md § Unconfirmed). Full SMS reading
// stays in the router's own web UI.
function SmsInbox({ status }: { status: RouterStatus }) {
  const host = prefs().netgearHost || DEFAULT_HOST;
  const summary = status.smsReady
    ? status.smsUnread > 0
      ? `**${status.smsUnread} unread message${status.smsUnread === 1 ? "" : "s"}**`
      : "No unread messages"
    : "SMS not ready";
  const markdown = [
    "# SMS",
    "",
    summary,
    "",
    "Message bodies aren't exposed by `model.json` — open the router's own web UI to read them.",
  ].join("\n");

  return (
    <Detail
      navigationTitle="SMS"
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser title="Open Web Ui" url={host} />
        </ActionPanel>
      }
    />
  );
}
