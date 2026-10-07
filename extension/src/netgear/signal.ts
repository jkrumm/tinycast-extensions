// Pure LTE signal rating and `ping` summary parsing for the Signal Meter. No
// `@raycast/api` import — runs under vitest (see signal.test.ts).

export type SignalRating = "excellent" | "good" | "fair" | "poor";

export interface SignalReadings {
  sinr: number | null; // dB
  rsrp: number | null; // dBm
  rsrq: number | null; // dB
}

export interface SignalRatings {
  sinr: SignalRating | null;
  rsrp: SignalRating | null;
  rsrq: SignalRating | null;
  overall: SignalRating | null;
}

const ORDER: readonly SignalRating[] = ["poor", "fair", "good", "excellent"];

// Lower bounds of excellent / good / fair; anything below the last is poor.
// The standard LTE rule-of-thumb bands.
export const SINR_BANDS = [20, 13, 0] as const; // dB
export const RSRP_BANDS = [-80, -90, -100] as const; // dBm
export const RSRQ_BANDS = [-10, -15, -20] as const; // dB

function rate(
  value: number | null,
  bands: readonly [number, number, number],
): SignalRating | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= bands[0]) return "excellent";
  if (value >= bands[1]) return "good";
  if (value >= bands[2]) return "fair";
  return "poor";
}

function worst(
  a: SignalRating | null,
  b: SignalRating | null,
): SignalRating | null {
  if (a === null) return b;
  if (b === null) return a;
  return ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b;
}

// Per-metric ratings plus an overall verdict. Overall is the worst of SINR and
// RSRP: SINR is the decisive one (it is what throughput and packet loss follow,
// so it leads the headline and carries the verdict alone when RSRP is missing),
// but a signal too weak to hold the link (RSRP) never reads better than it is.
// RSRQ is shown and rated but never moves the verdict — it is a ratio of the
// other two and swings with cell load.
export function rateSignal(readings: SignalReadings): SignalRatings {
  const sinr = rate(readings.sinr, SINR_BANDS);
  const rsrp = rate(readings.rsrp, RSRP_BANDS);
  const rsrq = rate(readings.rsrq, RSRQ_BANDS);
  return { sinr, rsrp, rsrq, overall: worst(sinr, rsrp) };
}

// The next rating up from `rating`'s threshold, for "good from 13 dB" hints;
// null when already excellent (or unrated).
export function nextThreshold(
  rating: SignalRating | null,
  bands: readonly [number, number, number],
): { rating: SignalRating; value: number } | null {
  if (rating === "poor") return { rating: "fair", value: bands[2] };
  if (rating === "fair") return { rating: "good", value: bands[1] };
  if (rating === "good") return { rating: "excellent", value: bands[0] };
  return null;
}

export interface PingStats {
  lossPercent: number;
  // null when every packet was lost — there is no round-trip line then.
  avgMs: number | null;
}

// macOS `ping` summary:
//   4 packets transmitted, 3 packets received, 25.0% packet loss
//   round-trip min/avg/max/stddev = 28.1/35.2/42.3/5.1 ms
// null when the output carries no summary (ping missing, or killed early).
export function parsePingSummary(output: string): PingStats | null {
  const loss = output.match(/(\d+(?:\.\d+)?)%\s+packet loss/);
  if (!loss) return null;
  const rtt = output.match(
    /=\s*\d+(?:\.\d+)?\/(\d+(?:\.\d+)?)\/\d+(?:\.\d+)?\/\d+(?:\.\d+)?\s*ms/,
  );
  return {
    lossPercent: Number(loss[1]),
    avgMs: rtt ? Number(rtt[1]) : null,
  };
}
