// LocalStorage glue for the `van-sampler` background command — shared between
// the command (`van-sampler.tsx`, via sampler-runner.ts, which saves after every
// run) and `van-power.tsx` (which shows the status line and pauses/resumes).
// Imports `@raycast/api`, so — like storage.ts — glue, not pure logic.

import { LocalStorage } from "@raycast/api";
import {
  INITIAL_SAMPLER_STATE,
  SamplerState,
  migrateSamplerState,
} from "./sampler";

export const VAN_SAMPLER_KEY = "van-sampler";

export async function loadSamplerState(): Promise<SamplerState> {
  const raw = await LocalStorage.getItem<string>(VAN_SAMPLER_KEY);
  if (!raw) return INITIAL_SAMPLER_STATE;
  try {
    return migrateSamplerState(JSON.parse(raw));
  } catch {
    return INITIAL_SAMPLER_STATE;
  }
}

export async function saveSamplerState(state: SamplerState): Promise<void> {
  await LocalStorage.setItem(VAN_SAMPLER_KEY, JSON.stringify(state));
}

// Re-reads before writing: a run may have saved since the view loaded its copy.
export async function setSamplerPaused(paused: boolean): Promise<SamplerState> {
  const next = { ...(await loadSamplerState()), paused };
  await saveSamplerState(next);
  return next;
}
