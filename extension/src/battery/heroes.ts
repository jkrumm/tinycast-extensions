// Images for the Battery view — pure (no @raycast/api), so the unit tests and
// `make previews` render exactly what the command embeds. A status panel
// (charge + health) and one quiet row of secondary metrics; every number is
// drawn once, so there is no table.

import {
  PanelColumn,
  StatCard,
  statCards,
  statusPanel,
  thresholdColor,
  toDataUri,
} from "../lib/svg";
import { batteryHealthPercent } from "./parse";
import { BatterySnapshot } from "./types";

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

// Charge (battery cell, a tick at the cap, state · watts · limit underneath)
// and health (with the cycle count) — only when ioreg parsed.
export function panelColumns(snapshot: BatterySnapshot): PanelColumn[] {
  const { status, hardware } = snapshot;
  const { battery, configuration } = status;
  const watts = battery.chargeRateWatts;
  const columns: PanelColumn[] = [
    {
      label: "Charge",
      value: battery.currentChargePercent,
      unit: "%",
      percent: battery.currentChargePercent,
      gauge: "battery",
      color: thresholdColor(battery.currentChargePercent, {
        invert: true,
        lowBoundary: 20,
        highBoundary: 40,
      }),
      marker: configuration.enabled
        ? configuration.upperLimitPercent
        : undefined,
      sub: [
        stateLabel(battery.state),
        `${watts.toFixed(1)} W`,
        configuration.enabled
          ? `limit ${configuration.upperLimitPercent}%`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    },
  ];
  if (hardware) {
    const health = batteryHealthPercent(hardware);
    columns.push({
      label: "Health",
      value: health,
      unit: "%",
      percent: health,
      gauge: "bar",
      color: thresholdColor(health, { invert: true }),
      sub: `${hardware.cycleCount} cycles`,
    });
  }
  return columns;
}

export function panelImage(snapshot: BatterySnapshot): string {
  return toDataUri(statusPanel({ columns: panelColumns(snapshot) }));
}

// Voltage, temperature (only when ioreg parsed) and the adapter.
export function metricCards(snapshot: BatterySnapshot): StatCard[] {
  const { status, hardware } = snapshot;
  const { charging, battery } = status;
  const cards: StatCard[] = [
    { label: "Voltage", value: battery.voltageVolts.toFixed(2), unit: "V" },
  ];
  if (hardware) {
    cards.push({
      label: "Temperature",
      value: hardware.temperatureCelsius.toFixed(1),
      unit: "°C",
    });
  }
  cards.push({
    label: "Adapter",
    value: !charging.pluggedIn
      ? "On battery"
      : charging.useAdapter
        ? "Plugged in"
        : "Blocked",
    tone: charging.pluggedIn && !charging.useAdapter ? "warn" : undefined,
  });
  return cards;
}

export function metricsImage(snapshot: BatterySnapshot): string {
  const cards = metricCards(snapshot);
  return toDataUri(
    statCards({ cards, size: "compact", columns: cards.length }),
  );
}
