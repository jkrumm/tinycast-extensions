import { updateCommandMetadata } from "@raycast/api";
import { runSamplerOnce } from "./van/sampler-runner";

// No-view background command (package.json: `interval: "15m"`) — off by default
// until run once or toggled on in Settings → Extensions → Van Sampler →
// Background refresh (see AGENTS.md). Takes the same live read as opening Van
// Power (Ective frame + Victron advert, never the connected Victron session) so
// the charts, the SoC estimate and the daily consumption have readings while
// nobody looks, and posts a macOS notification when the battery crosses down
// through 30 % / 15 %. Tinycast kills a background run after
// min(max(interval, 15), 120) s — 120 s here; the helper's own 15 s deadline
// fits. No toast or HUD exists in a background run: `updateCommandMetadata`'s
// subtitle is the only surface. Paused from the Van Power view (Pause / Resume
// Background Sampling); a paused run returns at once.
export default async function VanSampler(): Promise<void> {
  const subtitle = await runSamplerOnce();
  await updateCommandMetadata({ subtitle });
}
