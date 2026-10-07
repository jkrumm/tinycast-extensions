// Pure state + Detail markdown for the Signal Meter (signal-meter.tsx): a
// session-only history of radio readings, and the view drawn from it — verdict
// headline, a three-column panel (SINR / RSRP / RSRQ), a SINR trend, a
// reference table, and the tip. No `@raycast/api` import — runs under vitest.

import {
  RAYCAST_COLOR,
  THEME,
  areaChart,
  formatNumber,
  statusPanel,
  toDataUri,
} from "../lib/svg";
import type { PanelColumn } from "../lib/svg";
import { RouterStatus } from "./types";
import {
  PingStats,
  RSRP_BANDS,
  RSRQ_BANDS,
  SINR_BANDS,
  SignalRating,
  nextThreshold,
  rateSignal,
} from "./signal";

export const MAX_SAMPLES = 60;

export interface SignalSample {
  at: number; // epoch ms
  sinr: number | null;
  rsrp: number | null;
  rsrq: number | null;
  rssi: number | null;
  band: string;
  // Registered on a mobile network — false means limited service.
  registered: boolean;
  cellId: string | null;
  caSecondaryCells: number | null;
  txLevel: number;
  pingAvgMs: number | null;
  lossPercent: number | null;
}

export interface SignalHistory {
  samples: SignalSample[]; // oldest first, at most MAX_SAMPLES
  best: { sinr: number; at: number } | null;
}

export const EMPTY_HISTORY: SignalHistory = { samples: [], best: null };

export function toSample(
  status: RouterStatus,
  ping: PingStats | null,
  at: number,
): SignalSample {
  return {
    at,
    sinr: status.sinr,
    rsrp: status.rsrp,
    rsrq: status.rsrq,
    rssi: status.rssi,
    band: status.band,
    registered: status.registered,
    cellId: status.cellId,
    caSecondaryCells: status.caSecondaryCells,
    txLevel: status.txLevel,
    pingAvgMs: ping?.avgMs ?? null,
    lossPercent: ping?.lossPercent ?? null,
  };
}

// A tie refreshes the best's timestamp: "best 9 dB, 4 s ago" is the more useful
// fact when the router is sitting at the best spot again.
export function pushSample(
  history: SignalHistory,
  sample: SignalSample,
): SignalHistory {
  const best =
    sample.sinr !== null &&
    (history.best === null || sample.sinr >= history.best.sinr)
      ? { sinr: sample.sinr, at: sample.at }
      : history.best;
  return {
    samples: [...history.samples, sample].slice(-MAX_SAMPLES),
    best,
  };
}

const RATING_LABEL: Record<SignalRating, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

function ratingColor(rating: SignalRating | null) {
  switch (rating) {
    case "excellent":
    case "good":
      return THEME.color.good;
    case "fair":
      return THEME.color.warn;
    case "poor":
      return THEME.color.bad;
    default:
      return THEME.color.muted;
  }
}

const dB = (value: number | null) =>
  value === null ? "—" : `${formatNumber(value)} dB`;
const dBm = (value: number | null) =>
  value === null ? "—" : `${formatNumber(value)} dBm`;

// The compact one-line form for the main status view's pair table, e.g.
// "Fair · SINR 4 dB · RSRP −98". Null when the router reports no LTE signal.
export function signalRow(status: RouterStatus): string | null {
  const { overall } = rateSignal(status);
  if (overall === null) return null;
  const parts: string[] = [RATING_LABEL[overall]];
  if (status.sinr !== null) parts.push(`SINR ${formatNumber(status.sinr)} dB`);
  if (status.rsrp !== null) parts.push(`RSRP ${formatNumber(status.rsrp)}`);
  return parts.join(" · ");
}

// A gauge reads left-to-right "worse → better" across the range that matters.
function gaugePercent(value: number | null, lo: number, hi: number): number {
  if (value === null) return 0;
  return ((value - lo) / (hi - lo)) * 100;
}

function column(opts: {
  label: string;
  value: number | null;
  unit: string;
  rating: SignalRating | null;
  bands: readonly [number, number, number];
  range: [number, number];
}): PanelColumn {
  const next = nextThreshold(opts.rating, opts.bands);
  const sub = [
    opts.rating ? RATING_LABEL[opts.rating] : "No reading",
    next
      ? `${RATING_LABEL[next.rating]} from ${formatNumber(next.value)} ${opts.unit}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    label: opts.label,
    value: opts.value,
    unit: opts.unit,
    percent: gaugePercent(opts.value, ...opts.range),
    color: ratingColor(opts.rating),
    sub,
  };
}

export function panelColumns(sample: SignalSample): PanelColumn[] {
  const ratings = rateSignal(sample);
  return [
    column({
      label: "SINR",
      value: sample.sinr,
      unit: "dB",
      rating: ratings.sinr,
      bands: SINR_BANDS,
      range: [-5, 30],
    }),
    column({
      label: "RSRP",
      value: sample.rsrp,
      unit: "dBm",
      rating: ratings.rsrp,
      bands: RSRP_BANDS,
      range: [-120, -70],
    }),
    column({
      label: "RSRQ",
      value: sample.rsrq,
      unit: "dB",
      rating: ratings.rsrq,
      bands: RSRQ_BANDS,
      range: [-20, -3],
    }),
  ];
}

export function panelImage(sample: SignalSample): string {
  return toDataUri(statusPanel({ columns: panelColumns(sample) }));
}

// SINR over the session. Null until there are two readings to draw a line
// through. The last value is already the panel's big number.
export function trendImage(samples: SignalSample[]): string | null {
  const readings = samples.filter((s) => s.sinr !== null);
  if (readings.length < 2) return null;
  return toDataUri(
    areaChart(
      {
        times: readings.map((s) => s.at),
        series: [
          {
            color: RAYCAST_COLOR.blue,
            values: readings.map((s) => s.sinr),
            format: (v) => `${formatNumber(v)} dB`,
          },
        ],
        lastValues: false,
        // The whole session is a couple of minutes: minute ticks would all
        // read the same.
        xFormat: (t) =>
          new Date(t).toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
      },
      { height: 150 },
    ),
  );
}

// Same shape as status-view.ts's pair table: zero-width headers, two
// label/value pairs per row.
function pairTable(pairs: [string, string][]): string[] {
  const rows = ["| | | | |", "|-|-|-|-|"];
  for (let i = 0; i < pairs.length; i += 2) {
    const [a, b = ["", ""]] = [pairs[i], pairs[i + 1]];
    rows.push(`| ${a[0]} | ${a[1]} | ${b[0]} | ${b[1]} |`);
  }
  return rows;
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

function withRating(text: string, rating: SignalRating | null): string {
  return rating ? `${text} · ${RATING_LABEL[rating]}` : text;
}

function pingRow(sample: SignalSample): string {
  if (sample.lossPercent === null) return "—";
  const avg =
    sample.pingAvgMs === null
      ? "no reply"
      : `${Math.round(sample.pingAvgMs)} ms avg`;
  return `${avg} · ${formatNumber(sample.lossPercent)}% loss`;
}

export function tableRows(
  sample: SignalSample,
  best: SignalHistory["best"],
): [string, string][] {
  const ratings = rateSignal(sample);
  return [
    ["SINR", withRating(dB(sample.sinr), ratings.sinr)],
    ["RSRP", withRating(dBm(sample.rsrp), ratings.rsrp)],
    ["RSRQ", withRating(dB(sample.rsrq), ratings.rsrq)],
    ["RSSI", dBm(sample.rssi)],
    ["Band", sample.band || "—"],
    ["Cell ID", sample.cellId ?? "—"],
    [
      "CA secondary cells",
      sample.caSecondaryCells === null ? "—" : String(sample.caSecondaryCells),
    ],
    ["Tx power", `${formatNumber(sample.txLevel)} dBm`],
    ["Ping", pingRow(sample)],
    [
      "Best SINR",
      best ? `${dB(best.sinr)} · ${ago(sample.at - best.at)}` : "—",
    ],
  ];
}

export const SIGNAL_TIP =
  "_Move the router (window, higher, away from metal/the Mac); hold each spot ~10 s._";

export function signalMarkdown(opts: {
  history: SignalHistory;
  // The latest refresh failed; the last good reading (if any) stays on screen.
  error?: string | null;
}): string {
  const { history, error } = opts;
  const latest = history.samples[history.samples.length - 1];
  if (!latest) {
    return error
      ? `# No reading yet\n\n> ⚠️ ${error}\n\n${SIGNAL_TIP}`
      : "Loading…";
  }
  const { overall } = rateSignal(latest);
  const lead =
    latest.sinr !== null
      ? `SINR ${dB(latest.sinr)}`
      : latest.rsrp !== null
        ? `RSRP ${dBm(latest.rsrp)}`
        : null;
  const headline = !latest.registered
    ? `# Not registered (limited service)${lead ? ` — ${lead}` : ""}`
    : overall && lead
      ? `# ${RATING_LABEL[overall]} — ${lead}`
      : "# No LTE signal reading";
  const lines = [headline];
  if (error) lines.push("", `> ⚠️ ${error} Showing the last reading.`);
  lines.push("", `![Signal](${panelImage(latest)})`);
  const trend = trendImage(history.samples);
  if (trend) lines.push("", `![Trend](${trend})`);
  lines.push("", ...pairTable(tableRows(latest, history.best)));
  lines.push("", SIGNAL_TIP);
  return lines.join("\n");
}
