// Pure display text for the Home command and its dashboard tile.

import { Doctor, Scene } from "./types";

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
): string {
  if (!scenes) return "No scenes yet";
  const attention = attentionRows(doctor).length;
  if (attention > 0) return `${attention} need attention`;
  return `${scenes.length} scenes`;
}
