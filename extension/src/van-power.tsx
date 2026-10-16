import { useEffect, useMemo, useState } from "react";
import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  Toast,
  environment,
  getPreferenceValues,
  showToast,
  Keyboard,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import {
  VictronHistoryView,
  loadConsumption,
  loadVan,
  loadVictronCache,
  loadVictronHistory,
} from "./van/load";
import {
  chargeChartImage,
  consumptionChartImage,
  consumptionSummaryText,
  statusPanelImage,
  yieldChartImage,
  yieldTotalText,
} from "./van/heroes";
import { batteryWarnings } from "./van/format";
import { defaultLocation } from "./van/sun";
import { DayConsumption, hasPendingDays } from "./van/consumption";
import { SamplerState, samplerStatusLine } from "./van/sampler";
import { loadSamplerState, setSamplerPaused } from "./van/sampler-storage";
import { migrateLegacyVanStorage } from "./van/legacy";
import { configureVanRuntime } from "./van/runtime";
import { Preferences } from "./lib/preferences";
import { Sample, VanView } from "./van/types";
import {
  Stamped,
  formatAge,
  freshnessBanner,
  stamped,
  updatingLine,
} from "./lib/freshness";

const NO_HISTORY: VictronHistoryView = {
  history: null,
  trends: null,
  updatedAt: null,
  error: null,
  reason: null,
};

// The Victron's own data — the 3-day charts from the cache the moment the view
// opens, topped up when a read lands — and, below it, one quiet line about how
// old that is and that a read is under way.
function pushVictronSection(
  lines: string[],
  opts: {
    samples: Sample[];
    now: number;
    victron: VictronHistoryView | undefined;
    consumption: Array<DayConsumption | null> | undefined;
    working: boolean;
    capacityAh?: number | null;
  },
): void {
  const { samples, now, victron, consumption, working, capacityAh } = opts;
  const charge = chargeChartImage({
    samples,
    trends: victron?.trends ?? null,
    now,
    location: defaultLocation(now),
    capacityAh,
  });
  if (charge) lines.push("", `![Charge](${charge})`);

  const history = victron?.history ?? null;
  const yieldChart = yieldChartImage(history);
  if (yieldChart) {
    const total = yieldTotalText(history);
    lines.push(
      "",
      `### Solar yield · last 14 days${total ? ` · ${total}` : ""}`,
      "",
      `![Yield](${yieldChart})`,
    );
  }

  const consumptionChart = consumption
    ? consumptionChartImage(consumption)
    : null;
  if (consumption && consumptionChart) {
    const summary = consumptionSummaryText(consumption);
    lines.push(
      "",
      `### Consumption · last 14 days${summary ? ` · ${summary}` : ""}`,
      "",
      `![Consumption](${consumptionChart})`,
      "",
      "_Faded days rest mostly on an estimate. Charging the Victron does not see (shore power, alternator) reads as lower consumption._",
    );
    if (hasPendingDays(consumption)) {
      lines.push(
        "",
        "_Victron data pending for the faintest days — the charge current is fetched when this view opens and about every 3 h in the background._",
      );
    }
  }

  const hasData = charge !== null || yieldChart !== null;
  if (working && hasData && victron?.updatedAt) {
    lines.push(
      "",
      `_Victron data updated ${formatAge(victron.updatedAt, now)} · reading Victron…_`,
    );
  } else if (working && !hasData) {
    lines.push("", "_Reading the Victron… (about 25 s)_");
  } else if (!hasData && victron?.error) {
    lines.push("", `_${victron.error}_`);
  }
}

function renderMarkdown(
  data: Stamped<VanView> | undefined,
  error: unknown,
  isLoading: boolean,
  victron: VictronHistoryView | undefined,
  consumption: Array<DayConsumption | null> | undefined,
  sampler: SamplerState | undefined,
  historyLoading: boolean,
): string {
  if (!data) {
    if (error) {
      return `# Van Power\n\n> ⚠️ ${error instanceof Error ? error.message : String(error)}`;
    }
    // Nothing live yet: the cached Victron charts still paint at once.
    const lines = ["# Van Power", "", "_Reading Bluetooth… (up to 15 s)_"];
    pushVictronSection(lines, {
      samples: [],
      now: Date.now(),
      victron,
      consumption,
      working: true,
    });
    return lines.join("\n");
  }

  const view = data.data;
  const { battery, solar, issues } = view.reading;
  const lines = ["# Van Power"];
  const banner = freshnessBanner({
    fetchedAt: data.fetchedAt,
    error,
    offlineLabel: "Van not reachable",
  });
  if (banner) lines.push("", banner);

  // Warnings first (when there are any), then the status panel and the quiet
  // metrics row; every number is drawn once, so there is no table.
  for (const issue of issues) lines.push("", `> ⚠️ ${issue}`);
  if (battery && battery.errorFlags.length > 0) {
    lines.push("", `> ⚠️ **BMS:** ${battery.errorFlags.join(", ")}`);
  }
  if (solar?.chargerError) {
    lines.push("", `> ⚠️ **Charger error ${solar.chargerError}**`);
  }
  for (const warning of batteryWarnings(view.reading)) {
    lines.push("", `> ⚠️ ${warning}`);
  }
  const panel = statusPanelImage(view);
  if (panel) lines.push("", `![Status](${panel})`);

  pushVictronSection(lines, {
    samples: view.samples,
    now: data.fetchedAt,
    victron,
    consumption,
    working: isLoading || historyLoading,
    capacityAh: battery?.capacityAh,
  });

  if (sampler) lines.push("", `_${samplerStatusLine(sampler)}_`);

  // Kept last so it never shifts the hero image above.
  const updating = updatingLine({ fetchedAt: data.fetchedAt, isLoading });
  if (updating) lines.push("", updating);

  return lines.join("\n");
}

// The van code takes its paths and preferences from the host (van/runtime.ts)
// so the launchd sampler can run it without `@raycast/api`.
configureVanRuntime(() => ({
  supportDir: environment.supportPath,
  assetsDir: environment.assetsPath,
  preferences: getPreferenceValues<Preferences>(),
}));

// The state used to live in LocalStorage; the first open moves it into the
// files the launchd sampler shares (van/legacy.ts) before anything reads them.
// Every loader below takes `migrated` as an argument, so it runs (again) once
// the move is done.
function useLegacyMigrated(): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    migrateLegacyVanStorage()
      .catch(() => {})
      .finally(() => setDone(true));
  }, []);
  return done;
}

// The hooks' `execute` already holds the loaders back; this keeps one from
// ever reading the files before the move has finished.
function whenMigrated<T>(ready: boolean, load: () => Promise<T>): Promise<T> {
  return ready
    ? load()
    : Promise.reject(new Error("migrating Van Power state"));
}

export default function VanPower() {
  const migrated = useLegacyMigrated();
  const { data, isLoading, error, revalidate } = useCachedPromise(
    (ready: boolean) => whenMigrated(ready, () => stamped(loadVan)),
    [migrated],
    { keepPreviousData: true, execute: migrated, onError: () => {} },
  );
  // The history read opens a connected session that blocks the charger's
  // advert, so it starts only once the live read has finished (and the cache
  // inside loadVictronHistory keeps it to once an hour). `liveDone` is an
  // argument so a finished live read re-triggers the load.
  // `isLoading` is false before the first load has even started, so a landed
  // result (or error) is required too.
  const liveDone =
    migrated && !isLoading && (data !== undefined || error !== undefined);
  const history = useCachedPromise(
    (ready: boolean) =>
      ready ? loadVictronHistory() : Promise.resolve(NO_HISTORY),
    [liveDone],
    {
      keepPreviousData: true,
      execute: liveDone,
      onError: () => {},
    },
  );
  // What the store holds paints on the first frame; a landed read replaces it.
  const cached = useCachedPromise(
    (ready: boolean) => whenMigrated(ready, loadVictronCache),
    [migrated],
    {
      execute: migrated,
      onError: () => {},
    },
  );
  const victron = history.data ?? cached.data;
  // The two weeks of consumption come from the logs plus what the stores hold:
  // computed from the cache on the first frame, again when the live reading
  // lands and when the Victron read has merged the day's charger current in.
  const consumption = useCachedPromise(
    (liveAt: number, victronAt: number, ready: boolean) =>
      whenMigrated(ready, () =>
        loadConsumption(Math.max(Date.now(), liveAt, victronAt)),
      ),
    [data?.fetchedAt ?? 0, victron?.updatedAt ?? 0, migrated],
    { keepPreviousData: true, execute: migrated, onError: () => {} },
  );
  const sampler = useCachedPromise(
    (ready: boolean) => whenMigrated(ready, loadSamplerState),
    [migrated],
    {
      keepPreviousData: true,
      execute: migrated,
      onError: () => {},
    },
  );
  const markdown = useMemo(
    () =>
      renderMarkdown(
        data,
        error,
        isLoading,
        victron,
        consumption.data,
        sampler.data,
        history.isLoading,
      ),
    [
      data,
      error,
      isLoading,
      victron,
      consumption.data,
      sampler.data,
      history.isLoading,
    ],
  );
  const samplerPaused = sampler.data?.paused ?? false;

  // Written through to the `paused` flag file the launchd sampler reads, so it
  // takes effect at its next run (a paused run returns at once).
  async function toggleSampler() {
    const paused = !samplerPaused;
    await setSamplerPaused(paused);
    await showToast({
      style: Toast.Style.Success,
      title: paused
        ? "Background sampling paused"
        : "Background sampling resumed",
    });
    sampler.revalidate();
  }

  // A live read while the history session is open would find the charger
  // silent; ask for a moment's patience instead.
  function refresh() {
    if (history.isLoading) {
      showToast({
        title: "Reading the Victron history — try again in a moment",
      });
      return;
    }
    revalidate();
  }

  return (
    <Detail
      isLoading={!migrated || isLoading || history.isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={refresh}
          />
          <Action
            title={
              samplerPaused
                ? "Resume Background Sampling"
                : "Pause Background Sampling"
            }
            icon={samplerPaused ? Icon.Play : Icon.Pause}
            onAction={toggleSampler}
          />
        </ActionPanel>
      }
    />
  );
}
