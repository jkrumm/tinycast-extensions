// Pure display formatting for Van Power (view, hub tile).

import { Sample, VanReading } from "./types";

const MINUS = "−";

export function formatAmps(amps: number): string {
  const magnitude = Math.abs(amps).toFixed(1);
  const sign = magnitude === "0.0" ? "" : amps > 0 ? "+" : MINUS;
  return `${sign}${magnitude} A`;
}

export function formatEta(hours: number): string {
  if (hours < 1) return `~${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `~${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return days > 14 ? ">14 d" : `~${days} d`;
}

export function formatYield(wh: number): string {
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh} Wh`;
}

// ≤18 characters, e.g. `82% · +8.4A`.
export function tileStatus(sample: Sample | undefined): string {
  if (!sample) return "No reading yet";
  const parts = [
    sample.soc !== null ? `${sample.soc}%` : null,
    sample.batA !== null ? formatAmps(sample.batA).replace(" ", "") : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No reading yet";
}

// Cell imbalance and temperature are only worth a look when they go wrong, so
// they are warning lines rather than permanent metrics. A healthy LiFePO4 pack
// sits well under 20 mV of spread mid-charge, but cells naturally diverge at
// the top and bottom of the charge curve (50 mV at 99 % in absorption is
// normal) — so a spread only warns from 100 mV anywhere, or from 50 mV while
// the charge is between 20 and 90 %.
export const CELL_SPREAD_WARN_MV = 50;
export const CELL_SPREAD_ALWAYS_WARN_MV = 100;
export const CELL_SPREAD_MID_SOC: [number, number] = [20, 90];
export const TEMP_COLD_C = 5;
export const TEMP_HOT_C = 40;

export function batteryWarnings(reading: VanReading): string[] {
  const { battery } = reading;
  if (!battery) return [];
  const warnings: string[] = [];
  if (battery.cellsMv.length > 0) {
    const spread = Math.max(...battery.cellsMv) - Math.min(...battery.cellsMv);
    const midCharge =
      battery.soc >= CELL_SPREAD_MID_SOC[0] &&
      battery.soc <= CELL_SPREAD_MID_SOC[1];
    if (
      spread >= CELL_SPREAD_ALWAYS_WARN_MV ||
      (midCharge && spread >= CELL_SPREAD_WARN_MV)
    ) {
      warnings.push(
        `**Cell spread ${spread} mV** — the cells are out of balance.`,
      );
    }
  }
  if (battery.tempC < TEMP_COLD_C) {
    warnings.push(
      `**Battery at ${battery.tempC.toFixed(1)} °C** — LiFePO4 must not be charged near freezing.`,
    );
  } else if (battery.tempC > TEMP_HOT_C) {
    warnings.push(
      `**Battery at ${battery.tempC.toFixed(1)} °C** — running hot.`,
    );
  }
  return warnings;
}
