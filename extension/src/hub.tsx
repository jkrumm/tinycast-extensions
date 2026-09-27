import { mkdir } from "fs/promises";
import { join } from "path";
import {
  Action,
  ActionPanel,
  Grid,
  Icon,
  LocalStorage,
  launchCommand,
  LaunchType,
  environment,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { client } from "./ticktick/client";
import { isOverdue, isDueToday } from "./ticktick/format";
import { getQuota } from "./usage/quota";
import { isQuotaError } from "./usage/types";
import { prefs } from "./lib/argo";
import { CurlNetgearHttp } from "./netgear/transport";
import { NetgearClient } from "./netgear/client";
import { collectBatterySnapshot } from "./battery/collect";
import { SpeedTestRecord } from "./speed-test/types";
import { RAYCAST_COLOR, RaycastColor, tile, toDataUri } from "./lib/svg";

const DEFAULT_NETGEAR_HOST = "http://192.168.1.1";
const SPEED_TEST_HISTORY_KEY = "speed-test-history";

interface TileConfig {
  command: string;
  glyph: string;
  name: string;
  color: RaycastColor;
}

const TILES: TileConfig[] = [
  { command: "my-tasks", glyph: "T", name: "Tasks", color: RAYCAST_COLOR.blue },
  {
    command: "quick-add",
    glyph: "+",
    name: "Add Task",
    color: RAYCAST_COLOR.purple,
  },
  {
    command: "claude-usage",
    glyph: "U",
    name: "Claude Usage",
    color: RAYCAST_COLOR.orange,
  },
  {
    command: "netgear",
    glyph: "N",
    name: "Netgear",
    color: RAYCAST_COLOR.green,
  },
  {
    command: "speed-test",
    glyph: "S",
    name: "Speed Test",
    color: RAYCAST_COLOR.magenta,
  },
  {
    command: "battery",
    glyph: "B",
    name: "Battery",
    color: RAYCAST_COLOR.yellow,
  },
];

async function tasksStatus(): Promise<string> {
  const projects = await client.getProjects();
  const results = await Promise.all(
    projects.map((p) => client.getProjectData(p.id)),
  );
  const tasks = results.flatMap((r) => r.tasks).filter((t) => t.status === 0);
  const overdue = tasks.filter((t) => isOverdue(t.dueDate)).length;
  const dueToday = tasks.filter((t) => isDueToday(t.dueDate)).length;
  if (overdue > 0) return `${overdue} overdue`;
  if (dueToday > 0) return `${dueToday} due today`;
  return "All clear";
}

async function usageStatus(): Promise<string> {
  const quota = await getQuota();
  if (isQuotaError(quota)) return "Error";
  const fiveHour = Math.round(quota.five_hour.utilization ?? 0);
  const sevenDay = Math.round(quota.seven_day.utilization ?? 0);
  return `5h ${fiveHour}% · 7d ${sevenDay}%`;
}

async function netgearStatus(): Promise<string> {
  await mkdir(environment.supportPath, { recursive: true });
  const jarPath = join(environment.supportPath, "netgear-cookies.jar");
  const host = prefs().netgearHost?.replace(/\/$/, "") || DEFAULT_NETGEAR_HOST;
  const netClient = new NetgearClient({
    host,
    transport: new CurlNetgearHttp(jarPath),
  });
  const status = await netClient.getStatus();
  const type = status.connectionText || status.connection;
  return `${type} · ${status.radioQuality}%`;
}

async function speedTestStatus(): Promise<string> {
  const raw = await LocalStorage.getItem<string>(SPEED_TEST_HISTORY_KEY);
  const history = raw ? (JSON.parse(raw) as SpeedTestRecord[]) : [];
  if (history.length === 0) return "No test yet";
  return `${history[0].dlMbps} Mbps`;
}

async function batteryStatus(): Promise<string> {
  const snapshot = await collectBatterySnapshot();
  const percent = snapshot.status.battery.currentChargePercent;
  const limit = snapshot.status.configuration.enabled
    ? `${snapshot.status.configuration.upperLimitPercent}%`
    : "100%";
  return `${percent}% · limit ${limit}`;
}

const STATUS_LOADERS: Record<string, () => Promise<string>> = {
  "my-tasks": tasksStatus,
  "quick-add": async () => "Natural language",
  "claude-usage": usageStatus,
  netgear: netgearStatus,
  "speed-test": speedTestStatus,
  battery: batteryStatus,
};

// Each tile fetches its own status independently — a slow source (Netgear
// on a dead LTE link, a cold Claude usage fetch) never blocks the rest of
// the grid. The static tile (glyph + name, "…" status) renders immediately;
// `usePromise` fills in the live status once it resolves.
function HubTile({ config }: { config: TileConfig }) {
  const loader = STATUS_LOADERS[config.command];
  const { data: status } = usePromise(loader ?? (async () => ""));

  const svg = tile(
    {
      glyph: config.glyph,
      name: config.name,
      status: status ?? "…",
      color: config.color,
    },
    { width: 400, height: 400 },
  );

  return (
    <Grid.Item
      key={config.command}
      content={toDataUri(svg)}
      title={config.name}
      actions={
        <ActionPanel>
          <Action
            title={`Open ${config.name}`}
            icon={Icon.ArrowRight}
            onAction={() =>
              launchCommand({
                name: config.command,
                type: LaunchType.UserInitiated,
              })
            }
          />
        </ActionPanel>
      }
    />
  );
}

export default function Hub() {
  return (
    <Grid columns={3} aspectRatio="1" fit={Grid.Fit.Fill}>
      {TILES.map((config) => (
        <HubTile key={config.command} config={config} />
      ))}
    </Grid>
  );
}
