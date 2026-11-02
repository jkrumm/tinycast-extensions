import {
  Color,
  Icon,
  LaunchType,
  MenuBarExtra,
  launchCommand,
  showHUD,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { formatAge } from "./lib/freshness";
import { runNamiPresence, runScene } from "./home/actions";
import {
  climateLines,
  menuBarTitle,
  namiTitle,
  namiToggleTarget,
  sensorUnreachable,
  someoneHomeTitle,
} from "./home/format";
import { loadMenuBar } from "./home/run";

export default function HomeMenuBar() {
  const { data, isLoading, revalidate } = useCachedPromise(
    () => loadMenuBar(),
    [],
    { keepPreviousData: true },
  );
  const status = data?.status?.status ?? null;
  const climate = status?.climate ?? null;
  const lines = climateLines(climate);
  const namiHome = status?.namiHome ?? null;
  const target = namiToggleTarget(namiHome);

  const toggleNami = async () => {
    if (target === null) return;
    await runNamiPresence(target, showHUD);
    await revalidate();
  };

  return (
    <MenuBarExtra
      icon={Icon.House}
      title={status ? menuBarTitle(status) : undefined}
      isLoading={isLoading}
      tooltip="Home"
    >
      <MenuBarExtra.Section title="Climate">
        {lines.map((line) => (
          <MenuBarExtra.Item key={line.id} title={line.title} />
        ))}
        {lines.length === 0 && (
          <MenuBarExtra.Item title={data?.error ?? "No reading yet"} />
        )}
        {sensorUnreachable(climate) && (
          <MenuBarExtra.Item
            icon={{ source: Icon.Warning, tintColor: Color.Orange }}
            title="Sensor unreachable — showing last known"
          />
        )}
        {data?.status && (
          <MenuBarExtra.Item
            title={`Updated ${formatAge(data.status.fetchedAt)}`}
          />
        )}
        {data?.error && lines.length > 0 && (
          <MenuBarExtra.Item
            icon={{ source: Icon.Warning, tintColor: Color.Orange }}
            title={data.error}
          />
        )}
      </MenuBarExtra.Section>

      <MenuBarExtra.Section title="Nami">
        <MenuBarExtra.Item
          icon={namiHome ? Icon.Checkmark : Icon.Person}
          title={namiTitle(namiHome)}
          onAction={target === null ? undefined : toggleNami}
        />
        <MenuBarExtra.Item
          title={someoneHomeTitle(status?.someoneHome ?? null)}
        />
      </MenuBarExtra.Section>

      {data && data.scenes.length > 0 && (
        <MenuBarExtra.Section title="Scenes">
          {data.scenes.map((scene) => (
            <MenuBarExtra.Item
              key={scene.id}
              icon={Icon.Play}
              title={scene.name}
              onAction={() =>
                runScene(scene.name, showHUD, undefined, scene.id)
              }
            />
          ))}
        </MenuBarExtra.Section>
      )}

      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Open Home"
          icon={Icon.Sidebar}
          onAction={() =>
            launchCommand({ name: "home", type: LaunchType.UserInitiated })
          }
        />
        <MenuBarExtra.Item
          title="Refresh"
          icon={Icon.ArrowClockwise}
          onAction={revalidate}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
