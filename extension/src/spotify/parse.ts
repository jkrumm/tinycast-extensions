// Pure half of the Spotify commands: defensive parsing of `home audio` JSON,
// HUD line, Detail markdown and the volume arguments. No @raycast/api.

import { SpotifyState } from "./types";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// Malformed or non-object input yields null, never a throw.
export function parseState(raw: string): SpotifyState | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(json)) return null;
  return {
    status: str(json.status),
    active: bool(json.active),
    volume: num(json.volume),
    output: str(json.output),
    track: str(json.track),
    artists: Array.isArray(json.artists)
      ? json.artists.filter((a): a is string => typeof a === "string")
      : [],
    album: str(json.album),
    context: str(json.context),
    cover: str(json.cover),
    positionMs: num(json.position_ms),
    durationMs: num(json.duration_ms),
    shuffle: bool(json.shuffle),
    repeat: str(json.repeat),
  };
}

// ─── Volume arguments ───────────────────────────────────────────────────────

// The CLI clamps to 0..100; `+N` / `-N` are relative, a bare number absolute.
export const volumeDelta = (delta: number): string =>
  delta >= 0 ? `+${delta}` : String(delta);

export const volumeAbsolute = (percent: number): string =>
  String(Math.min(100, Math.max(0, Math.round(percent))));

// ─── Text ───────────────────────────────────────────────────────────────────

export const isPlaying = (state: SpotifyState): boolean =>
  state.status === "playing";

export const statusIcon = (state: SpotifyState): string =>
  isPlaying(state) ? "▶" : "⏸";

export const artistLine = (state: SpotifyState): string =>
  state.artists.join(", ");

const volumeText = (state: SpotifyState): string | null =>
  state.volume === null ? null : `${Math.round(state.volume)} %`;

// "▶ Charmed — Σtella, Redinho · 50 %"; nothing loaded: "Spotify idle".
export function hudLine(state: SpotifyState): string {
  if (!state.track) return "Spotify idle";
  const artists = artistLine(state);
  const title = artists ? `${state.track} — ${artists}` : state.track;
  const volume = volumeText(state);
  return `${statusIcon(state)} ${title}${volume ? ` · ${volume}` : ""}`;
}

export const formatClock = (ms: number | null): string | null => {
  if (ms === null || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

export const statusTitle = (state: SpotifyState | null): string => {
  if (!state) return "Spotify on Mine";
  if (!state.track) return "Nothing loaded";
  return state.status === "playing"
    ? "Playing"
    : state.status === "paused"
      ? "Paused"
      : (state.status ?? "Idle");
};

// Escape characters that markdown would swallow in a title.
const escape = (text: string): string => text.replace(/([\\`*_[\]|])/g, "\\$1");

export function stateMarkdown(state: SpotifyState | null): string {
  if (!state) return "# Spotify on Mine\n\nNo reading yet.";
  const lines: string[] = [];
  if (state.cover) lines.push(`![](${state.cover})`, "");
  lines.push(`# ${escape(state.track ?? "Nothing loaded")}`);
  const artists = artistLine(state);
  if (artists) lines.push("", `**${escape(artists)}**`);
  const where = [state.album, state.context].filter(
    (v): v is string => v !== null,
  );
  if (where.length) lines.push("", escape(where.join(" · ")));

  const position = formatClock(state.positionMs);
  const duration = formatClock(state.durationMs);
  const rows: [string, string | null][] = [
    ["Status", statusTitle(state)],
    ["Volume", volumeText(state)],
    ["Output", state.output],
    [
      "Active device",
      state.active === null ? null : state.active ? "Mine" : "Another device",
    ],
    ["Position", position && duration ? `${position} / ${duration}` : position],
  ];
  const shown = rows.filter((r): r is [string, string] => r[1] !== null);
  lines.push("", "| | |", "|-|-|");
  for (const [label, value] of shown)
    lines.push(`| ${label} | ${escape(value)} |`);
  return lines.join("\n");
}

export const tileStatus = (state: SpotifyState | null): string => {
  if (!state?.track) return "Idle";
  return `${statusIcon(state)} ${state.track}`;
};
