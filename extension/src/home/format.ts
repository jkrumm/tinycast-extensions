// Pure display text for the Home command and its dashboard tile.

import { Climate, Doctor, HomeStatus, Scene } from "./types";

export type AttentionKind = "unreachable" | "battery";

export interface AttentionRow {
  id: string;
  kind: AttentionKind;
  title: string;
  subtitle: string;
  tag: string;
  copy: string;
}

export const sceneSubtitle = (scene: Scene): string => scene.rooms.join(", ");

const where = (room: string | null, extra: string | null): string =>
  [room, extra].filter(Boolean).join(" · ");

// Unreachable accessories first, then low batteries (lowest charge first).
export function attentionRows(doctor: Doctor | null): AttentionRow[] {
  if (!doctor) return [];
  const unreachable = doctor.unreachable.map((a, i) => ({
    id: `unreachable-${i}-${a.name}`,
    kind: "unreachable" as const,
    title: a.name,
    subtitle: where(a.room, a.manufacturer),
    tag: "Unreachable",
    copy: `${a.name}${a.room ? ` (${a.room})` : ""} is unreachable`,
  }));
  const battery = [...doctor.lowBattery]
    .sort((a, b) => a.battery - b.battery)
    .map((a, i) => ({
      id: `battery-${i}-${a.name}`,
      kind: "battery" as const,
      title: a.name,
      subtitle: where(a.room, null),
      tag: `${a.battery}%`,
      copy: `${a.name}${a.room ? ` (${a.room})` : ""} battery at ${a.battery}%`,
    }));
  return [...unreachable, ...battery];
}

// Maps a failed `home` call (stderr text or spawn error) to a sentence.
export function friendlyError(message: string): string {
  const text = message.trim();
  if (/unreachable/i.test(text) && /homeclaw/i.test(text))
    return "HomeClaw is unreachable. Is the mini online and the app running?";
  if (/ENOENT/.test(text))
    return "The `home` CLI is missing from ~/.local/bin.";
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(text))
    return "Home did not answer in time. Is the mini reachable?";
  return text.split("\n")[0] || "Home failed without a message.";
}

export function tileStatus(
  scenes: Scene[] | null,
  doctor: Doctor | null,
  status: HomeStatus | null = null,
): string {
  const attention = attentionRows(doctor).length;
  if (attention > 0) return `${attention} need attention`;
  const temp = status?.climate?.temperatureC;
  if (temp != null) {
    const nami =
      status?.namiHome == null
        ? ""
        : ` · Nami ${status.namiHome ? "home" : "out"}`;
    return `${formatTemperature(temp)}${nami}`;
  }
  if (!scenes) return "No scenes yet";
  return `${scenes.length} scenes`;
}

// ─── Status (climate + Nami) ────────────────────────────────────────────────

const HUMID_AT = 60;
const DRY_AT = 35;

export const formatTemperature = (c: number): string => `${c.toFixed(1)}°`;

// Compact status-item title: `21.9° 42%`. Parts that are unknown are left out.
export function menuBarTitle(status: HomeStatus | null): string {
  const climate = status?.climate;
  const parts = [
    climate?.temperatureC != null
      ? formatTemperature(climate.temperatureC)
      : null,
    climate?.humidityPct != null ? `${Math.round(climate.humidityPct)}%` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "--";
}

// `21.9° · 42%` for the list row.
export const climateSummary = (climate: Climate): string =>
  menuBarTitle({ climate, namiHome: null, someoneHome: null }).replace(
    " ",
    " · ",
  );

export function humidityHint(pct: number | null): string | null {
  if (pct === null) return null;
  if (pct >= HUMID_AT) return "ventilate";
  if (pct <= DRY_AT) return "dry air";
  return null;
}

export interface ClimateLine {
  id: "temperature" | "humidity" | "battery";
  title: string;
}

// The known climate readings as display lines (unknown ones are skipped).
export function climateLines(climate: Climate | null): ClimateLine[] {
  if (!climate) return [];
  const lines: ClimateLine[] = [];
  if (climate.temperatureC !== null)
    lines.push({
      id: "temperature",
      title: `Temperature: ${climate.temperatureC.toFixed(1)} °C`,
    });
  if (climate.humidityPct !== null) {
    const hint = humidityHint(climate.humidityPct);
    lines.push({
      id: "humidity",
      title: `Humidity: ${Math.round(climate.humidityPct)} %${hint ? ` — ${hint}` : ""}`,
    });
  }
  if (climate.batteryPct !== null)
    lines.push({
      id: "battery",
      title: `Eve Room battery: ${Math.round(climate.batteryPct)} %`,
    });
  return lines;
}

export const sensorUnreachable = (climate: Climate | null): boolean =>
  climate?.reachable === false;

export const namiTitle = (namiHome: boolean | null): string =>
  namiHome === null
    ? "Nami: unknown"
    : namiHome
      ? "Nami is home"
      : "Nami is with you";

// The value a toggle sets; null when the state is unknown (nothing to flip).
export const namiToggleTarget = (namiHome: boolean | null): boolean | null =>
  namiHome === null ? null : !namiHome;

export const namiToggleTitle = (namiHome: boolean | null): string =>
  namiHome === false ? "Nami Stays Home" : "Nami Comes Along";

export const someoneHomeTitle = (someoneHome: boolean | null): string =>
  `Someone home: ${someoneHome === null ? "unknown" : someoneHome ? "yes" : "no"}`;

// An unreachable sensor reports holes; fill the climate numbers from the last
// reading. The switches (Nami, someone home) are never back-filled: a stale
// switch state shown as current would offer the wrong toggle.
export function mergeClimate(
  fresh: Climate | null,
  cached: Climate | null,
): { climate: Climate | null; lastKnown: boolean } {
  if (!fresh) return { climate: cached, lastKnown: cached !== null };
  if (fresh.reachable !== false || !cached)
    return { climate: fresh, lastKnown: false };
  const merged: Climate = {
    sensor: fresh.sensor ?? cached.sensor,
    reachable: false,
    temperatureC: fresh.temperatureC ?? cached.temperatureC,
    humidityPct: fresh.humidityPct ?? cached.humidityPct,
    batteryPct: fresh.batteryPct ?? cached.batteryPct,
  };
  return { climate: merged, lastKnown: true };
}
