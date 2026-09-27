import { useCallback } from "react";
import {
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  Form,
  confirmAlert,
  Alert,
  showToast,
  Toast,
  openExtensionPreferences,
  environment,
  useNavigation,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { mkdir } from "fs/promises";
import { join } from "path";
import { prefs } from "./lib/argo";
import { CurlNetgearHttp } from "./netgear/transport";
import { NetgearClient } from "./netgear/client";
import { RouterStatus } from "./netgear/types";

const DEFAULT_HOST = "http://192.168.1.1";

async function getClient(): Promise<NetgearClient> {
  await mkdir(environment.supportPath, { recursive: true });
  const jarPath = join(environment.supportPath, "netgear-cookies.jar");
  const host = prefs().netgearHost?.replace(/\/$/, "") || DEFAULT_HOST;
  return new NetgearClient({ host, transport: new CurlNetgearHttp(jarPath) });
}

// Elevates to Admin automatically when a password preference is set — Guest
// role otherwise, which still exposes read-only status.
async function loadStatus(): Promise<RouterStatus> {
  const client = await getClient();
  const status = await client.getStatus();
  const password = prefs().netgearPassword;
  if (status.userRole !== "Admin" && password) {
    return client.login(password);
  }
  return status;
}

function statusMarkdown(status: RouterStatus): string {
  const lines = [
    `# ${status.connectionText || status.connection}`,
    "",
    `**${status.operator || "No operator"}**${status.roaming ? " (roaming)" : ""}`,
    "",
    `Band: ${status.band || "—"} · Signal: ${status.radioQuality}% (rx ${status.rxLevel} dBm / tx ${status.txLevel} dBm)`,
    "",
    `Data transferred (cycle): ${status.dataTransferredGB} GB`,
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
  return lines.join("\n");
}

function batteryColor(status: RouterStatus): Color {
  if (status.charging) return Color.Green;
  if (status.battChargeLevel < 20) return Color.Red;
  if (status.battChargeLevel < 50) return Color.Orange;
  return Color.SecondaryText;
}

async function requirePasswordOrToast(): Promise<string | null> {
  const password = prefs().netgearPassword;
  if (!password) {
    await showToast({
      style: Toast.Style.Failure,
      title: "No admin password set",
      message: "Set the Netgear Admin Password in extension preferences",
      primaryAction: {
        title: "Open Preferences",
        onAction: () => openExtensionPreferences(),
      },
    });
    return null;
  }
  return password;
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
      metadata={
        status && (
          <Detail.Metadata>
            <Detail.Metadata.Label
              title="Role"
              text={status.userRole}
              icon={
                status.userRole === "Admin"
                  ? { source: Icon.Checkmark, tintColor: Color.Green }
                  : { source: Icon.Person, tintColor: Color.SecondaryText }
              }
            />
            <Detail.Metadata.Label
              title="Connection"
              text={status.connection}
            />
            <Detail.Metadata.Label
              title="Battery"
              text={`${status.battChargeLevel}% (${status.batteryState}${status.charging ? ", charging" : ""})`}
              icon={{ source: Icon.Battery, tintColor: batteryColor(status) }}
            />
            <Detail.Metadata.Label title="SIM" text={status.simStatus} />
            {status.connectedClients !== null && (
              <Detail.Metadata.Label
                title="Connected Clients"
                text={String(status.connectedClients)}
                icon={Icon.Devices}
              />
            )}
            <Detail.Metadata.Separator />
            <Detail.Metadata.Link
              title="Web UI"
              target={prefs().netgearHost || DEFAULT_HOST}
              text={prefs().netgearHost || DEFAULT_HOST}
            />
          </Detail.Metadata>
        )
      }
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
