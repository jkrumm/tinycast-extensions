// One run of the `van-sampler` background command. Paused: nothing happens.
// Otherwise the same live read an open of Van Power does (`readAndPersist` —
// Ective frame + Victron Instant Readout advert, appended to the 72 h samples
// and the capture log), then the state is saved and a low-battery alert posted
// when the charge crossed down through a threshold. Nothing found is an
// outcome, not an error: no sample, no throw. After that, when the charger was
// heard and its cached trends are over 3 h old, the connected-session top-up an
// open does (`loadVictronHistory`, sampler.ts `trendsTopUpDue`) keeps the
// charge-current trend growing so the daily consumption works without opening
// Van Power. Returns the launcher subtitle.

import { loadVictronHistory, readAndPersist } from "./load";
import { postNotification } from "./notify";
import {
  SamplerResult,
  SamplerState,
  applyRun,
  applyTrendsTopUp,
  classifyRead,
  formatSamplerSubtitle,
  trendsTopUpDue,
} from "./sampler";
import { loadSamplerState, saveSamplerState } from "./sampler-storage";
import { loadVictronHistoryCache } from "./storage";

type LiveRead = Awaited<ReturnType<typeof readAndPersist>>;

async function topUpTrends(opts: {
  state: SamplerState;
  read: LiveRead | null;
  now: number;
}): Promise<SamplerState> {
  const { state, read, now } = opts;
  const cache = await loadVictronHistoryCache();
  if (
    !trendsTopUpDue({
      state,
      victronHeard: read?.helper.victron != null,
      batteryRead: read?.helper.battery != null,
      trendsUpdatedAt: cache?.updatedAt ?? null,
      now,
    })
  ) {
    return state;
  }
  // Saved before the read: a run Tinycast kills mid-session still counts as an
  // attempt and is not repeated at the next 15-minute tick.
  const attempting = { ...state, lastTrendsAttemptAt: now };
  await saveSamplerState(attempting);
  let reason: string | null;
  try {
    reason = (await loadVictronHistory(now)).reason;
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  const next = applyTrendsTopUp(attempting, { now, reason });
  await saveSamplerState(next);
  return next;
}

export async function runSamplerOnce(
  now: number = Date.now(),
): Promise<string> {
  const stored = await loadSamplerState();
  if (stored.paused) return formatSamplerSubtitle(stored);

  let read: LiveRead | null = null;
  let result: SamplerResult;
  try {
    read = await readAndPersist("background");
    result = classifyRead(read);
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
  try {
    return formatSamplerSubtitle(await topUpTrends({ state, read, now }));
  } catch {
    // The live read is saved; a failing top-up must not fail the run.
    return formatSamplerSubtitle(state);
  }
}
