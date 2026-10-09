// One run of the `van-sampler` background command. Paused: nothing happens.
// Otherwise the same live read an open of Van Power does (`readAndPersist` —
// Ective frame + Victron Instant Readout advert, appended to the 72 h samples
// and the capture log; never the connected Victron GATT session), then the
// state is saved and a low-battery alert posted when the charge crossed down
// through a threshold. Nothing found is an outcome, not an error: no sample, no
// throw. Returns the launcher subtitle.

import { readAndPersist } from "./load";
import { postNotification } from "./notify";
import {
  SamplerResult,
  applyRun,
  classifyRead,
  formatSamplerSubtitle,
} from "./sampler";
import { loadSamplerState, saveSamplerState } from "./sampler-storage";

export async function runSamplerOnce(
  now: number = Date.now(),
): Promise<string> {
  const stored = await loadSamplerState();
  if (stored.paused) return formatSamplerSubtitle(stored);

  let result: SamplerResult;
  try {
    result = classifyRead(await readAndPersist("background"));
  } catch (e) {
    result = {
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const { state, alert } = applyRun(stored, { now, result });
  await saveSamplerState(state);
  if (alert) {
    await postNotification({ title: "Van battery", body: alert.text });
  }
  return formatSamplerSubtitle(state);
}
