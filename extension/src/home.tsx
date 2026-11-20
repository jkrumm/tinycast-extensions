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
import { formatAge } from "./lib/freshness";
import HomeClimate from "./home-climate";
import {
  AttentionRow,
  attentionRows,
  climateSummary,
  deviceStateText,
  formatTemperature,
  friendlyError,
  humidityHint,
  namiTitle,
  namiToggleTarget,
  namiToggleTitle,
  sceneSubtitle,
  sensorUnreachable,
  someoneHomeTitle,
} from "./home/format";
import {
  localStorageHome,
  localStorageStatus,
  namiPresence,
  refreshHome,
  refreshStatus,
  setBrightness,
  setPower,
  triggerScene,
} from "./home/run";
import { Device, HomeCache, Scene, StatusCache } from "./home/types";

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

  // Optimistic change to one Lights row (keyed by its first accessory id); the
  // refresh that follows replaces it with what the lamp reports.
  const patchDevice = useCallback((id: string, patch: Partial<Device>) => {
    setCache(
      (current) =>
        current && {
          ...current,
          devices: current.devices.map((d) =>
            d.ids[0] === id ? { ...d, ...patch } : d,
          ),
        },
    );
  }, []);

  return { cache, isLoading, error, refresh, patchDevice };
}

// Same stale-while-revalidate for the climate/Nami reading; a failed refresh
// keeps the last known value on screen and raises its own failure toast.
function useStatus() {
  const [status, setStatus] = useState<StatusCache | null>(null);

  // Ignore a result older than the one already on screen.
  const apply = useCallback((next: StatusCache | null) => {
    if (!next) return;
    setStatus((current) =>
      current && current.fetchedAt > next.fetchedAt ? current : next,
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await refreshStatus());
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not refresh Home status",
        message: friendlyError(messageOf(e)),
      });
    }
  }, [apply]);

  useEffect(() => {
    let live = true;
    localStorageStatus
      .read()
      .catch(() => null)
      .then((stored) => {
        if (live && stored) setStatus((current) => current ?? stored);
      })
      .then(refresh);
    return () => {
      live = false;
    };
  }, [refresh]);

  return { status, refresh, apply };
}

async function toggleNami(
  target: boolean,
  apply: (written: StatusCache) => void,
) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: target ? "Nami stays home" : "Nami comes along",
  });
  try {
    apply(await namiPresence(target));
    toast.style = Toast.Style.Success;
    toast.title = target ? "Nami stays home" : "Nami comes along";
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Could not update Nami";
    toast.message = friendlyError(messageOf(error));
  }
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

const BRIGHTNESS_STEPS = [25, 50, 75, 100];

interface LightCopy {
  busy: string;
  done: string;
}

type LightChange = (
  device: Device,
  patch: Partial<Device>,
  copy: LightCopy,
  change: () => Promise<void>,
) => void;

// Runs one write for a Lights row behind a toast; the caller refreshes after.
async function runLightChange(
  device: Device,
  copy: LightCopy,
  change: () => Promise<void>,
) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: copy.busy,
  });
  try {
    await change();
    toast.style = Toast.Style.Success;
    toast.title = copy.done;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = `Could not change ${device.name}`;
    toast.message = friendlyError(messageOf(error));
  }
}

function LightItem({
  device,
  onChange,
  onRefresh,
}: {
  device: Device;
  onChange: LightChange;
  onRefresh: () => void;
}) {
  const turnOn = !device.on;
  return (
    <List.Item
      title={device.name}
      subtitle={device.room}
      icon={
        device.on
          ? { source: Icon.LightBulb, tintColor: Color.Yellow }
          : Icon.LightBulb
      }
      accessories={[{ text: deviceStateText(device) }]}
      actions={
        <ActionPanel>
          <Action
            title="Toggle Power"
            icon={Icon.Power}
            onAction={() =>
              onChange(
                device,
                { on: turnOn },
                {
                  busy: `${turnOn ? "Turning on" : "Turning off"} ${device.name}`,
                  done: `${device.name} is ${turnOn ? "on" : "off"}`,
                },
                () => setPower(device.ids, turnOn),
              )
            }
          />
          {device.dimmable ? (
            <ActionPanel.Submenu title="Set Brightness" icon={Icon.LightBulb}>
              {BRIGHTNESS_STEPS.map((pct, i) => (
                <Action
                  key={pct}
                  title={`${pct} %`}
                  shortcut={{ modifiers: ["cmd"], key: String(i + 1) as "1" }}
                  onAction={() =>
                    onChange(
                      device,
                      { on: true, brightness: pct },
                      {
                        busy: `Setting ${device.name} to ${pct} %`,
                        done: `${device.name} at ${pct} %`,
                      },
                      () => setBrightness(device.ids, pct),
                    )
                  }
                />
              ))}
            </ActionPanel.Submenu>
          ) : null}
          <RefreshAction onRefresh={onRefresh} />
        </ActionPanel>
      }
    />
  );
}

export default function Home() {
  const { cache, isLoading, error, refresh, patchDevice } = useHome();
  const attention = attentionRows(cache?.doctor ?? null);
  const {
    status: statusCache,
    refresh: refreshStatusNow,
    apply: applyStatus,
  } = useStatus();
  const status = statusCache?.status ?? null;
  const climate = status?.climate ?? null;
  const namiHome = status?.namiHome ?? null;
  const namiTarget = namiToggleTarget(namiHome);
  const refreshAll = () => {
    refresh();
    refreshStatusNow();
  };
  const changeLight: LightChange = (device, patch, copy, change) => {
    patchDevice(device.ids[0], patch);
    runLightChange(device, copy, change).then(refresh);
  };

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
      {statusCache ? (
        <List.Section title="Status">
          {climate ? (
            <List.Item
              title={climateSummary(climate)}
              subtitle={
                sensorUnreachable(climate)
                  ? "Sensor unreachable — last known"
                  : (humidityHint(climate.humidityPct) ?? "")
              }
              icon={Icon.Temperature}
              accessories={[
                ...(climate.batteryPct !== null
                  ? [{ tag: `Battery ${Math.round(climate.batteryPct)}%` }]
                  : []),
                { text: formatAge(statusCache.climateAt) },
              ]}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard
                    title="Copy Temperature"
                    content={
                      climate.temperatureC !== null
                        ? formatTemperature(climate.temperatureC)
                        : ""
                    }
                  />
                  <Action.Push
                    title="Show Climate History"
                    icon={Icon.LineChart}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "y" }}
                    target={<HomeClimate />}
                  />
                  <RefreshAction onRefresh={refreshAll} />
                </ActionPanel>
              }
            />
          ) : null}
          <List.Item
            title={namiTitle(namiHome)}
            icon={
              namiHome
                ? { source: Icon.Checkmark, tintColor: Color.Green }
                : Icon.Person
            }
            actions={
              <ActionPanel>
                {namiTarget !== null ? (
                  <Action
                    title={namiToggleTitle(namiHome)}
                    icon={Icon.Switch}
                    onAction={() => toggleNami(namiTarget, applyStatus)}
                  />
                ) : null}
                <RefreshAction onRefresh={refreshAll} />
              </ActionPanel>
            }
          />
          <List.Item
            title={someoneHomeTitle(status?.someoneHome ?? null)}
            icon={Icon.House}
            actions={
              <ActionPanel>
                <RefreshAction onRefresh={refreshAll} />
              </ActionPanel>
            }
          />
        </List.Section>
      ) : null}
      {cache && cache.devices.length > 0 ? (
        <List.Section title="Lights">
          {cache.devices.map((device) => (
            <LightItem
              key={device.ids[0]}
              device={device}
              onChange={changeLight}
              onRefresh={refresh}
            />
          ))}
        </List.Section>
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
