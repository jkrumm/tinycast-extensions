import { readFile } from "fs/promises";
import { join } from "path";
import {
  Action,
  ActionPanel,
  Grid,
  Icon,
  launchCommand,
  LaunchType,
  environment,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { isOverdue, isDueToday } from "./ticktick/format";
import { loadOpenTasks } from "./ticktick/load";
import { getQuota } from "./usage/quota";
import { isQuotaError } from "./usage/types";
import { getClient } from "./netgear/session";
import { collectBatterySnapshot } from "./battery/collect";
import { loadHistory } from "./speed-test/history";
import { loadVanHistory } from "./van/storage";
import { tileStatus } from "./van/format";
import { RAYCAST_COLOR, RaycastColor, tile, toDataUri } from "./lib/svg";

interface TileConfig {
  command: string;
  icon: string; // assets/src/<icon>.svg — the same art as the command icon
  glyph: string;
  name: string;
  color: RaycastColor;
}

const TILES: TileConfig[] = [
  {
    command: "my-tasks",
    icon: "tasks",
    glyph: "T",
    name: "Tasks",
    color: RAYCAST_COLOR.blue,
  },
  {
    command: "quick-add",
    icon: "add-task",
    glyph: "+",
    name: "Add Task",
    color: RAYCAST_COLOR.purple,
  },
  {
    command: "claude-usage",
    icon: "usage",
    glyph: "U",
    name: "Claude Usage",
    color: RAYCAST_COLOR.orange,
  },
  {
    command: "netgear",
    icon: "netgear",
    glyph: "N",
    name: "Netgear",
    color: RAYCAST_COLOR.green,
  },
  {
    command: "speed-test",
    icon: "speed-test",
    glyph: "S",
    name: "Speed Test",
    color: RAYCAST_COLOR.magenta,
  },
  {
    command: "battery",
    icon: "battery",
    glyph: "B",
    name: "Battery",
    color: RAYCAST_COLOR.yellow,
  },
  {
    command: "van-power",
    icon: "van",
    glyph: "V",
    name: "Van Power",
    color: RAYCAST_COLOR.purple,
  },
];

// One tile's live data: the status line and, where a source has history, a
// tiny trend drawn under it.
interface TileData {
  status: string;
  trend?: number[];
}

async function tasksStatus(): Promise<TileData> {
  const { tasks } = await loadOpenTasks();
  const overdue = tasks.filter((t) => isOverdue(t.dueDate)).length;
  const dueToday = tasks.filter((t) => isDueToday(t.dueDate)).length;
  if (overdue > 0) return { status: `${overdue} overdue` };
  if (dueToday > 0) return { status: `${dueToday} due today` };
  return { status: "All clear" };
}

async function usageStatus(): Promise<TileData> {
  const quota = await getQuota();
  if (isQuotaError(quota)) return { status: "Error" };
  const fiveHour = Math.round(quota.five_hour.utilization ?? 0);
  const sevenDay = Math.round(quota.seven_day.utilization ?? 0);
  return { status: `5h ${fiveHour}% · 7d ${sevenDay}%` };
}

async function netgearStatus(): Promise<TileData> {
  const client = await getClient();
  const status = await client.getStatus();
  if (status.simStatus === "Locked") return { status: "SIM locked" };
  if (status.simStatus === "Blocked") return { status: "SIM blocked" };
  const type = status.connectionText || status.connection;
  return { status: `${type} · ${status.radioQuality}%` };
}

async function speedTestStatus(): Promise<TileData> {
  const history = await loadHistory();
  if (history.length === 0) return { status: "No test yet" };
  return {
    status: `${history[0].dlMbps} Mbps`,
    trend: [...history].reverse().map((r) => r.dlMbps),
  };
}

async function batteryStatus(): Promise<TileData> {
  const snapshot = await collectBatterySnapshot();
  const percent = snapshot.status.battery.currentChargePercent;
  const limit = snapshot.status.configuration.enabled
    ? `${snapshot.status.configuration.upperLimitPercent}%`
    : "100%";
  return { status: `${percent}% · limit ${limit}` };
}

// Last stored sample only — a BLE read takes seconds and belongs to the
// Van Power command, never to a dashboard glance.
async function vanStatus(): Promise<TileData> {
  const history = await loadVanHistory();
  return {
    status: tileStatus(history[history.length - 1]),
    trend: history.flatMap((s) => (s.soc === null ? [] : [s.soc])),
  };
}

const STATUS_LOADERS: Record<string, () => Promise<TileData>> = {
  "my-tasks": tasksStatus,
  "quick-add": async () => ({ status: "" }),
  "claude-usage": usageStatus,
  netgear: netgearStatus,
  "speed-test": speedTestStatus,
  battery: batteryStatus,
  "van-power": vanStatus,
};

// The icon SVGs ship in the build's assets/src; drop the outer <svg> so the
// markup can be placed inside the tile.
async function loadIconMarkup(icon: string): Promise<string> {
  const svg = await readFile(
    join(environment.assetsPath, "src", `${icon}.svg`),
    "utf8",
  );
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
}

// Each tile fetches its own status independently — a slow source (Netgear
// on a dead LTE link, a cold Claude usage fetch) never blocks the rest of
// the grid, and an unreachable source shows "Offline" on its own tile
// instead of a toast (`onError` silences the generic failure toast
// `usePromise` shows by default). The static tile (glyph + name, "…"
// status) renders immediately; `usePromise` fills in the live status once
// it resolves.
function HubTile({ config }: { config: TileConfig }) {
  const loader = STATUS_LOADERS[config.command];
  const { data, error } = useCachedPromise(
    loader ?? (async () => ({ status: "" })),
    [],
    { onError: () => {}, keepPreviousData: true },
  );
  const { data: iconMarkup } = useCachedPromise(loadIconMarkup, [config.icon]);

  const svg = tile({
    glyph: config.glyph,
    name: config.name,
    status: error ? "Offline" : (data?.status ?? "…"),
    color: config.color,
    iconMarkup,
    trend: error ? undefined : data?.trend,
  });

  return (
    <Grid.Item
      key={config.command}
      content={toDataUri(svg)}
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
    <Grid columns={3} aspectRatio="16/9" fit={Grid.Fit.Fill}>
      {TILES.map((config) => (
        <HubTile key={config.command} config={config} />
      ))}
    </Grid>
  );
}
