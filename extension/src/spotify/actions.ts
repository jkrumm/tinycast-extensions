// Pure core of the no-view Spotify commands: run one action and turn the
// outcome into a single HUD line. `command.ts` binds it to showHUD.

import { friendlyError } from "../home/format";
import { RunHome, runHome } from "../home/run";
import { volumeDelta } from "./parse";
import { hudLine } from "./parse";
import { RunOsascript, audio, playOnMacBook, runOsascript } from "./run";
import { SpotifyState } from "./types";

export type Hud = (message: string) => Promise<void>;

export type SpotifyAction =
  | "toggle"
  | "next"
  | "previous"
  | "louder"
  | "quieter"
  | "muchQuieter"
  | "take"
  | "macbook"
  | { volume: string };

// `home audio` arguments for every action except the MacBook hand-over.
export const actionArgs = (
  action: Exclude<SpotifyAction, "macbook">,
): string[] => {
  if (typeof action === "object") return ["volume", action.volume];
  switch (action) {
    case "toggle":
      return ["toggle"];
    case "next":
      return ["next"];
    case "previous":
      return ["prev"];
    case "louder":
      return ["volume", volumeDelta(10)];
    case "quieter":
      return ["volume", volumeDelta(-10)];
    case "muchQuieter":
      return ["volume", volumeDelta(-30)];
    case "take":
      return ["take"];
  }
};

export function perform(
  action: SpotifyAction,
  run: RunHome = runHome,
  osascript: RunOsascript = runOsascript,
): Promise<SpotifyState> {
  if (action === "macbook") return playOnMacBook(run, osascript);
  return audio(actionArgs(action), run);
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Runs the action and reports the resulting state as one HUD line; a failure
// is one friendly line. Resolves with the state (null on failure).
export async function runSpotify(
  action: SpotifyAction,
  hud: Hud,
  run: RunHome = runHome,
  osascript: RunOsascript = runOsascript,
): Promise<SpotifyState | null> {
  try {
    const state = await perform(action, run, osascript);
    await hud(action === "macbook" ? "Playing on MacBook" : hudLine(state));
    return state;
  } catch (error) {
    await hud(`Spotify: ${friendlyError(messageOf(error))}`);
    return null;
  }
}
