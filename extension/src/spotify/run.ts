// The impure half of the Spotify commands: `home audio …` through the shared
// `home` spawn (ssh to the mini) and osascript for the MacBook's own Spotify.
// LocalStorage keeps the last reading so the view renders instantly.

import { LocalStorage } from "@raycast/api";
import { execFile } from "child_process";
import { PATH } from "../usage/local";
import { RunHome, runHome } from "../home/run";
import { parseState } from "./parse";
import { SpotifyState } from "./types";

const CACHE_KEY = "spotify-state";
const OSASCRIPT_TIMEOUT_MS = 10_000;

// Port: runs AppleScript, rejects with its stderr.
export type RunOsascript = (script: string) => Promise<void>;

export const runOsascript: RunOsascript = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: OSASCRIPT_TIMEOUT_MS, env: { ...process.env, PATH } },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        const detail = String(stderr).trim();
        reject(
          new Error(detail || (error.killed ? "timed out" : error.message)),
        );
      },
    );
  });

// One `home audio …` call; the CLI prints the state after the command.
export async function audio(
  args: string[],
  run: RunHome = runHome,
): Promise<SpotifyState> {
  const state = parseState(await run(["audio", ...args]));
  if (!state) throw new Error("home audio returned unreadable output");
  return state;
}

export const readCached = async (): Promise<SpotifyState | null> => {
  const raw = await LocalStorage.getItem<string>(CACHE_KEY).catch(() => null);
  return raw ? parseState(raw) : null;
};

// The state is stored in the CLI's own shape, so `parseState` reads it back.
export const writeCached = (state: SpotifyState): Promise<void> =>
  LocalStorage.setItem(
    CACHE_KEY,
    JSON.stringify({
      status: state.status,
      active: state.active,
      volume: state.volume,
      output: state.output,
      track: state.track,
      artists: state.artists,
      album: state.album,
      context: state.context,
      cover: state.cover,
      position_ms: state.positionMs,
      duration_ms: state.durationMs,
      shuffle: state.shuffle,
      repeat: state.repeat,
    }),
  ).catch(() => undefined);

// Release Mine, then let the MacBook's Spotify desktop app play. UNVERIFIED
// whether the app resumes locally after Mine released; macOS may ask once for
// Automation permission for Spotify.
export async function playOnMacBook(
  run: RunHome = runHome,
  osascript: RunOsascript = runOsascript,
): Promise<SpotifyState> {
  const released = await audio(["release"], run);
  try {
    await osascript('tell application "Spotify" to play');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Mine released, but MacBook Spotify failed: ${reason}`);
  }
  return released;
}
