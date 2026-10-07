import { useMemo } from "react";
import { Action, ActionPanel, Detail, Icon, showToast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import {
  VictronHistoryView,
  loadVan,
  loadVictronCache,
  loadVictronHistory,
} from "./van/load";
import {
  chargeChartImage,
  statusPanelImage,
  yieldChartImage,
  yieldTotalText,
} from "./van/heroes";
import { batteryWarnings } from "./van/format";
import { defaultLocation } from "./van/sun";
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
    working: boolean;
    capacityAh?: number | null;
  },
): void {
  const { samples, now, victron, working, capacityAh } = opts;
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
    working: isLoading || historyLoading,
    capacityAh: battery?.capacityAh,
  });

  // Kept last so it never shifts the hero image above.
  const updating = updatingLine({ fetchedAt: data.fetchedAt, isLoading });
  if (updating) lines.push("", updating);

  return lines.join("\n");
}

export default function VanPower() {
  const { data, isLoading, error, revalidate } = useCachedPromise(
    () => stamped(loadVan),
    [],
    { keepPreviousData: true, onError: () => {} },
  );
  // The history read opens a connected session that blocks the charger's
  // advert, so it starts only once the live read has finished (and the cache
  // inside loadVictronHistory keeps it to once an hour). `liveDone` is an
  // argument so a finished live read re-triggers the load.
  const liveDone = !isLoading;
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
  // What LocalStorage holds paints on the first frame; a landed read replaces it.
  const cached = useCachedPromise(loadVictronCache, [], { onError: () => {} });
  const victron = history.data ?? cached.data;
  const markdown = useMemo(
    () => renderMarkdown(data, error, isLoading, victron, history.isLoading),
    [data, error, isLoading, victron, history.isLoading],
  );

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
      isLoading={isLoading || history.isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={refresh}
          />
        </ActionPanel>
      }
    />
  );
}
