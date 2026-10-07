// Hero images for the Speed Test view — pure (no @raycast/api), so the unit
// tests and `make previews` render exactly what the command embeds.

import {
  PanelColumn,
  RAYCAST_COLOR,
  StatCard,
  areaChart,
  statCards,
  statusPanel,
  toDataUri,
} from "../lib/svg";
import { SpeedTestRecord } from "./types";

// The arc's own scale, not a fixed ceiling: always at least 150 Mbps, or
// 20% above the actual result — so a fast connection's arc never maxes out
// and reads as "pinned"/broken, and a slow one isn't stretched across an
// almost-empty ring either.
function gaugeScaleMbps(mbps: number): number {
  return Math.max(150, mbps * 1.2);
}

function gaugePercent(mbps: number): number {
  return Math.min(100, Math.round((mbps / gaugeScaleMbps(mbps)) * 100));
}

// The two headline speeds as a status panel: the bar's scale is its own (see
// gaugeScaleMbps), the line under it compares with the average of the stored
// tests. Fixed colours (not thresholdColor): "% of an arbitrary ceiling" has
// no good/bad reading on a metered LTE link.
export function panelImage(
  record: SpeedTestRecord,
  history: SpeedTestRecord[],
): string {
  const average = (pick: (r: SpeedTestRecord) => number | null) => {
    const values = history.map(pick).filter((v): v is number => v !== null);
    return values.length >= 3
      ? `avg ${Math.round(values.reduce((a, b) => a + b, 0) / values.length)} of last ${values.length}`
      : undefined;
  };
  const columns: PanelColumn[] = [
    {
      label: "Download",
      value: record.dlMbps,
      unit: "Mbps",
      percent: gaugePercent(record.dlMbps),
      color: RAYCAST_COLOR.blue,
      sub: average((r) => r.dlMbps),
    },
  ];
  if (record.ulMbps !== null) {
    columns.push({
      label: "Upload",
      value: record.ulMbps,
      unit: "Mbps",
      percent: gaugePercent(record.ulMbps),
      color: RAYCAST_COLOR.purple,
      sub: average((r) => r.ulMbps),
    });
  }
  return toDataUri(statusPanel({ columns }));
}

// Latency, responsiveness on a full test, and which interface ran it.
export function metricsImage(record: SpeedTestRecord): string {
  const cards: StatCard[] = [
    { label: "Latency", value: record.latencyMs, unit: "ms" },
  ];
  if (record.responsiveness !== null) {
    cards.push({
      label: "Responsiveness",
      value: Math.round(record.responsiveness),
      unit: "RPM",
    });
  }
  cards.push({ label: "Interface", value: record.interfaceName });
  return toDataUri(
    statCards({ cards, size: "compact", columns: cards.length }),
  );
}

// The download history chart; null until there are at least two tests.
export function historyImage(history: SpeedTestRecord[]): string | null {
  const chronological = [...history].reverse();
  if (chronological.length < 2) return null;
  const mbps = (v: number) => String(Math.round(v));
  const uploads = chronological.map((r) => r.ulMbps);
  return toDataUri(
    areaChart({
      times: chronological.map((r) => r.timestamp),
      lastValues: false, // the panel above already says both speeds
      series: [
        {
          label: "Download (Mbps)",
          color: RAYCAST_COLOR.blue,
          values: chronological.map((r) => r.dlMbps),
          format: mbps,
        },
        // Quick tests carry no upload — a few stray dots between gaps is noise.
        ...(uploads.filter((v) => v !== null).length * 2 >= uploads.length
          ? [
              {
                label: "Upload (Mbps)",
                color: RAYCAST_COLOR.purple,
                values: uploads,
                axis: "left" as const,
                fill: false,
                format: mbps,
              },
            ]
          : []),
      ],
    }),
  );
}
