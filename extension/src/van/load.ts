// Opening Van Power reads live and appends one sample to the 72 h history.
// Reads happen only here — never from the hub, never in the background.

import {
  VictronHistoryCache,
  appendSample,
  compactTrends,
  hasRequiredTrends,
  newestTrendSample,
  victronHistoryDue,
} from "./history";
import { toReading, toSample } from "./parse";
import { readVan, runVictronAll } from "./run";
import {
  loadVanHistory,
  loadVictronHistoryCache,
  saveVanHistory,
  saveVictronHistoryCache,
} from "./storage";
import { Sample, VanReading, VanView } from "./types";
import { environment } from "@raycast/api";
import { join } from "path";
import {
  CAPTURE_LOG_FILE,
  TRENDS_LOG_FILE,
  appendCaptureLog,
  appendEstimateUpdate,
  estimateUpdateEntry,
  appendTrendsLog,
  appendVictronReadLog,
  captureLogEntry,
  trendsLogLine,
} from "./capture-log";
import { estimateAt } from "./soc-estimate";
import { VictronHistory } from "./victron-history";
import { VictronTrends, mergeTrends } from "./victron-trends";

export async function loadVan(): Promise<VanView> {
  const { helper, keyMissing } = await readVan();
  const reading = toReading({ helper, keyMissing, now: Date.now() });
  // Nothing read at all: throw, so the view keeps showing the last cached
  // reading under an honest banner instead of replacing it with an empty one.
  if (!reading.battery && !reading.solar) {
    throw new Error(reading.issues.join(" "));
  }
  const previous = await loadVanHistory();
  await logCapture(reading, previous);
  const samples = appendSample(previous, toSample(reading));
  await saveVanHistory(samples);
  return { reading, samples };
}

const supportFile = (name: string): string =>
  join(environment.supportPath, name);

// The reading of this open whose live prediction is still to be logged.
let pendingCapture: {
  t: number;
  capacityAh: number;
  previous: { t: number; soc: number; netA: number | null }[];
} | null = null;

// The estimator-tuning log (capture-log.ts): this reading goes in at once with
// `estimateAtT: null, reason "stale-trends"` — the cache is hours old, a
// prediction from it would mislead — and `logLiveEstimate` replaces that with the
// real prediction (without this reading) once the Victron read has merged the
// day's charger current in. If the open ends first, "stale-trends" stands.
// Never throws — logging must not break the open.
async function logCapture(
  reading: VanReading,
  previous: Sample[],
): Promise<void> {
  try {
    if (!reading.battery) return;
    const entry = captureLogEntry(reading, null);
    if (!entry) return;
    appendCaptureLog({
      path: supportFile(CAPTURE_LOG_FILE),
      entry,
      now: reading.readAt,
    });
    pendingCapture = {
      t: reading.readAt,
      capacityAh: reading.battery.capacityAh,
      previous: previous.flatMap((s) =>
        s.soc === null ? [] : [{ t: s.t, soc: s.soc, netA: s.batA }],
      ),
    };
  } catch {
    // see above
  }
}

function logLiveEstimate(trends: VictronTrends | null): void {
  try {
    const capture = pendingCapture;
    if (!capture) return;
    pendingCapture = null;
    const estimate = hasRequiredTrends(trends)
      ? estimateAt({
          trends,
          captures: capture.previous,
          t: capture.t,
          capacityAh: capture.capacityAh,
        })
      : null;
    appendEstimateUpdate({
      path: supportFile(CAPTURE_LOG_FILE),
      entry: estimateUpdateEntry(capture.t, estimate),
    });
  } catch {
    // see above
  }
}

// What the Victron section renders: the newest daily history and 72 h trends
// we have (from the cache the moment the view opens, topped up when a read
// lands) and, when the last attempt got nothing, a quiet reason. Plain JSON for
// useCachedPromise; never a rejection — a failing Victron read must not break
// the view.
export interface VictronHistoryView {
  history: VictronHistory | null;
  trends: VictronTrends | null;
  updatedAt: number | null; // when anything was last read from the device
  error: string | null;
}

const viewOf = (
  cache: VictronHistoryCache | null,
  error: string | null,
): VictronHistoryView => ({
  history: cache?.history ?? null,
  trends: cache?.trends ?? null,
  updatedAt: cache?.updatedAt ?? null,
  error,
});

// No BLE: what LocalStorage holds, to paint on the first frame while the live
// read (and then the Victron read) are still running.
export async function loadVictronCache(): Promise<VictronHistoryView> {
  return viewOf(await loadVictronHistoryCache(), null);
}

// One connected session (~10–25 s) tops the cache up. Run only after the live
// read finished (the connected session blocks the charger's advert); every open
// does it, because it is cheap: only trend samples newer than the cache are
// fetched (`sinceMs`) and merged in, and the 30-day history is skipped unless it
// is from a previous day or over an hour old. A partial result is used.
export async function loadVictronHistory(
  now: number = Date.now(),
): Promise<VictronHistoryView> {
  const cache = await loadVictronHistoryCache();
  const needHistory = victronHistoryDue(cache, now);
  // An older cache that lacks battery current cannot be completed by an
  // incremental read: read the whole 72 h once more instead.
  const cachedTrends = hasRequiredTrends(cache?.trends ?? null)
    ? (cache?.trends ?? null)
    : null;
  const sinceMs = newestTrendSample(cachedTrends);
  // Every attempt is logged (start, then done/failed) so a missing sample can be
  // explained afterwards: a start with no end means the view was closed mid-read.
  const logPath = supportFile(CAPTURE_LOG_FILE);
  const startedAt = Date.now();
  appendVictronReadLog({
    path: logPath,
    entry: {
      t: startedAt,
      victronRead: {
        phase: "start",
        sinceMs: sinceMs ?? null,
        history: needHistory,
      },
    },
  });
  try {
    const all = await runVictronAll({ sinceMs, history: needHistory });
    const fresh = all.history.days.length > 0 ? all.history : null;
    const freshTrends = compactTrends(all.trends);
    // The charger gave nothing newer and nothing else was asked for: not a
    // failure — there simply was nothing to add (a sleeping charger logs nothing).
    const nothingNew =
      !fresh && !freshTrends && !needHistory && all.errors.length === 0;
    if (!fresh && !freshTrends && !nothingNew) {
      throw new Error(all.errors.join(", ") || "nothing returned");
    }
    const next: VictronHistoryCache = {
      attemptedAt: now,
      ok: true,
      updatedAt: now,
      historyAt: fresh ? now : (cache?.historyAt ?? null),
      history: fresh ?? cache?.history ?? null,
      trends: compactTrends(mergeTrends(cachedTrends, freshTrends, now)),
    };
    await saveVictronHistoryCache(next);
    logLiveEstimate(next.trends);
    const line = trendsLogLine(freshTrends, now);
    if (line) {
      appendTrendsLog({ path: supportFile(TRENDS_LOG_FILE), line, now });
    }
    appendVictronReadLog({
      path: logPath,
      entry: {
        t: Date.now(),
        victronRead: {
          phase: "done",
          ms: Date.now() - startedAt,
          newSamples:
            freshTrends?.trends.find((t) => t.vreg === 0xed8f)?.samples
              .length ?? 0,
          historyDays: all.history.days.length,
          errors: all.errors,
          ...(nothingNew ? { reason: "nothing newer on the device" } : {}),
        },
      },
    });
    return viewOf(next, null);
  } catch (e) {
    const failed: VictronHistoryCache = {
      attemptedAt: now,
      ok: false,
      updatedAt: cache?.updatedAt ?? null,
      historyAt: cache?.historyAt ?? null,
      history: cache?.history ?? null,
      trends: cache?.trends ?? null,
    };
    await saveVictronHistoryCache(failed).catch(() => {});
    const reason = e instanceof Error ? e.message : String(e);
    appendVictronReadLog({
      path: logPath,
      entry: {
        t: Date.now(),
        victronRead: { phase: "failed", ms: Date.now() - startedAt, reason },
      },
    });
    return viewOf(failed, `Victron history unavailable (${reason})`);
  }
}
