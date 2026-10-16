// Opening Van Power reads live and appends one sample to the 72 h history; the
// background sampler (scripts/van-sampler.ts → sampler-runner.ts) takes the same
// live read through `readAndPersist`. Never from the hub. No `@raycast/api`
// import: the launchd sampler loads this module too (runtime.ts).

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
import { vanRuntime } from "./runtime";
import {
  loadVanHistory,
  loadVictronHistoryCache,
  saveVanHistory,
  saveVictronHistoryCache,
} from "./storage";
import { HelperResult, Sample, VanReading, VanView } from "./types";
import { join } from "path";
import {
  CAPTURE_LOG_FILE,
  TRENDS_LOG_FILE,
  appendCaptureLog,
  appendEstimateUpdate,
  estimateUpdateEntry,
  appendTrendsLog,
  appendVictronReadLog,
  CaptureSource,
  captureLogEntry,
  parseCaptureLog,
  parseTrendsLog,
  readTextFile,
  trendsLogLine,
} from "./capture-log";
import {
  DayConsumption,
  dailyConsumption,
  mergeLongTrends,
} from "./consumption";
import { DEFAULT_CAPACITY_AH, SocCapture, estimateAt } from "./soc-estimate";
import { toCaptures } from "./soc-eval";
import { VictronHistory } from "./victron-history";
import { VictronTrends, mergeTrends } from "./victron-trends";

// The one live read + persist both callers share — the view on open and the
// background sampler: read Ective + Victron advert, append the reading to the
// capture log and the 72 h sample ring. `samples` is null when nothing could be
// read at all (nothing is persisted then). Never touches the Victron GATT
// session — that stays the view's own, after its live read.
export async function readAndPersist(source: CaptureSource): Promise<{
  reading: VanReading;
  helper: HelperResult;
  samples: Sample[] | null;
}> {
  const { helper, keyMissing } = await readVan({
    unattended: source === "background",
  });
  const reading = toReading({ helper, keyMissing, now: Date.now() });
  if (!reading.battery && !reading.solar) {
    return { reading, helper, samples: null };
  }
  const previous = await loadVanHistory();
  await logCapture(reading, previous, source);
  const samples = appendSample(previous, toSample(reading));
  await saveVanHistory(samples);
  return { reading, helper, samples };
}

export async function loadVan(): Promise<VanView> {
  const { reading, samples } = await readAndPersist("open");
  // Nothing read at all: throw, so the view keeps showing the last cached
  // reading under an honest banner instead of replacing it with an empty one.
  if (!samples) throw new Error(reading.issues.join(" "));
  return { reading, samples };
}

const supportFile = (name: string): string =>
  join(vanRuntime().supportDir, name);

// The reading of this open whose live prediction is still to be logged.
let pendingCapture: {
  t: number;
  capacityAh: number;
  previous: { t: number; soc: number; netA: number | null }[];
} | null = null;

// The estimator-tuning log (capture-log.ts): an open's reading goes in at once with
// `estimateAtT: null, reason "stale-trends"` — the cache is hours old, a
// prediction from it would mislead — and `logLiveEstimate` replaces that with the
// real prediction (without this reading) once the Victron read has merged the
// day's charger current in. If the open ends first, "stale-trends" stands.
// Never throws — logging must not break the open.
async function logCapture(
  reading: VanReading,
  previous: Sample[],
  source: CaptureSource,
): Promise<void> {
  try {
    if (!reading.battery) return;
    const entry = captureLogEntry(reading, null, source);
    if (!entry) return;
    appendCaptureLog({
      path: supportFile(CAPTURE_LOG_FILE),
      entry,
      now: reading.readAt,
    });
    // A background reading takes no Victron read, so it has no live estimate to
    // fill in later (its line says `estimateReason: "background"`).
    if (source === "background") return;
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
  reason: string | null; // the raw failure reason behind `error` (the background top-up reads it)
}

const viewOf = (
  cache: VictronHistoryCache | null,
  reason: string | null,
): VictronHistoryView => ({
  history: cache?.history ?? null,
  trends: cache?.trends ?? null,
  updatedAt: cache?.updatedAt ?? null,
  error: reason === null ? null : `Victron history unavailable (${reason})`,
  reason,
});

// No BLE: what the store holds, to paint on the first frame while the live
// read (and then the Victron read) are still running.
export async function loadVictronCache(): Promise<VictronHistoryView> {
  try {
    return viewOf(await loadVictronHistoryCache(), null);
  } catch {
    return viewOf(null, null); // unreadable: the view paints without it
  }
}

// Two processes top the cache up (the view on open, the launchd sampler every
// few hours), so a save must not revert what the other saved while this read
// was running. `snapshot` is what this read started from; the stored cache wins
// as the base when it moved on since.
async function currentBase(
  snapshot: VictronHistoryCache | null,
): Promise<VictronHistoryCache | null> {
  let stored: VictronHistoryCache | null;
  try {
    stored = await loadVictronHistoryCache();
  } catch {
    return snapshot;
  }
  if (!stored) return snapshot;
  const moved =
    (stored.updatedAt ?? 0) > (snapshot?.updatedAt ?? 0) ||
    stored.attemptedAt > (snapshot?.attemptedAt ?? 0);
  return moved ? stored : snapshot;
}

// One connected session (~10–25 s) tops the cache up. Run only after the live
// read finished (the connected session blocks the charger's advert); every open
// does it, and so does the background sampler when the cache is over 3 h old
// (sampler-runner.ts), because it is cheap: only trend samples newer than the cache are
// fetched (`sinceMs`) and merged in, and the 30-day history is skipped unless it
// is from a previous day or over an hour old. A partial result is used.
export async function loadVictronHistory(
  now: number = Date.now(),
): Promise<VictronHistoryView> {
  let cache: VictronHistoryCache | null;
  try {
    cache = await loadVictronHistoryCache();
  } catch (e) {
    return viewOf(null, e instanceof Error ? e.message : String(e));
  }
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
    const base = await currentBase(cache);
    const baseTrends = hasRequiredTrends(base?.trends ?? null)
      ? (base?.trends ?? null)
      : null;
    const next: VictronHistoryCache = {
      attemptedAt: now,
      ok: true,
      updatedAt: Math.max(now, base?.updatedAt ?? 0),
      historyAt: fresh ? now : (base?.historyAt ?? null),
      history: fresh ?? base?.history ?? null,
      trends: compactTrends(mergeTrends(baseTrends, freshTrends, now)),
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
    const base = await currentBase(cache);
    const failed: VictronHistoryCache = {
      attemptedAt: now,
      ok: false,
      updatedAt: base?.updatedAt ?? null,
      historyAt: base?.historyAt ?? null,
      history: base?.history ?? null,
      trends: base?.trends ?? null,
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
    return viewOf(failed, reason);
  }
}

// The last two weeks' consumption per local day (consumption.ts): 14 days need
// more than the 72 h cache, so the readings come from the capture
// log (60 days) and the Victron trends from the trends log (30 days), with what
// the store holds laid over them so today is fresh the moment a read lands.
// Plain JSON; never a rejection — a broken log must not break the view.
export async function loadConsumption(
  now: number = Date.now(),
): Promise<Array<DayConsumption | null>> {
  try {
    const [cache, samples] = await Promise.all([
      loadVictronHistoryCache(),
      loadVanHistory(),
    ]);
    const entries = parseCaptureLog(
      readTextFile(supportFile(CAPTURE_LOG_FILE)),
    );
    const byTime = new Map<number, SocCapture>();
    for (const c of toCaptures(entries)) byTime.set(c.t, c);
    for (const s of samples) {
      if (s.soc !== null) byTime.set(s.t, { t: s.t, soc: s.soc, netA: s.batA });
    }
    return dailyConsumption({
      trends: mergeLongTrends(
        parseTrendsLog(readTextFile(supportFile(TRENDS_LOG_FILE))),
        cache?.trends ?? null,
      ),
      captures: [...byTime.values()],
      now,
      capacityAh: entries.at(-1)?.ective.capacityAh ?? DEFAULT_CAPACITY_AH,
    });
  } catch {
    return [];
  }
}
