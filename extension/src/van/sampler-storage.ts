// File-backed state of the Van sampler (store.ts), shared between the launchd
// run (scripts/van-sampler.ts via sampler-runner.ts, which saves after every
// run) and `van-power.tsx` (which shows the status line and pauses/resumes).
// `sampler.json` is the daemon's; the pause flag is the view's — a `paused`
// file whose existence is the state, so neither process rewrites the other's.

import {
  INITIAL_SAMPLER_STATE,
  SamplerState,
  migrateSamplerState,
} from "./sampler";
import {
  PAUSED_FILE,
  SAMPLER_FILE,
  hasStoreFile,
  readStoreJson,
  setStoreFlag,
  writeStoreJson,
} from "./store";

export async function loadSamplerState(): Promise<SamplerState> {
  const stored = readStoreJson(SAMPLER_FILE);
  const state = stored ? migrateSamplerState(stored) : INITIAL_SAMPLER_STATE;
  return { ...state, paused: hasStoreFile(PAUSED_FILE) };
}

// `paused` is the flag's, never persisted here.
export async function saveSamplerState(state: SamplerState): Promise<void> {
  writeStoreJson(SAMPLER_FILE, { ...state, paused: undefined });
}

export async function setSamplerPaused(paused: boolean): Promise<SamplerState> {
  setStoreFlag(PAUSED_FILE, paused);
  return loadSamplerState();
}
