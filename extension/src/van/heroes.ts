// Images for the Van Power view — pure (no @raycast/api), so the unit tests and
// `make previews` render exactly what the command embeds. Layout, top down: a
// status panel (battery + solar), the 3-day charge chart, the 14-day yield
// bars. Every number is drawn once; anything that is only worth a look when it
// goes wrong (cell spread, temperature) is a warning line, not a metric.

import {
  PanelColumn,
  RAYCAST_COLOR,
  areaChart,
  barChart,
  heroRows,
  statusPanel,
  thresholdColor,
  toDataUri,
} from "../lib/svg";
import { formatAmps, formatEta, formatYield } from "./format";
import {
  HISTORY_WINDOW_MS,
  MIN_CHART_SAMPLES,
  recentSamples,
  timeToFullOrEmpty,
} from "./history";
import { solarPoints } from "./history";
import { estimateSoc, socSeries } from "./soc-estimate";
import { Location, nightSpans } from "./sun";
import { Sample, VanView } from "./types";
import { VictronDay, VictronHistory } from "./victron-history";
import { VictronTrends } from "./victron-trends";

// The solar gauge's own scale, not a panel rating: at least 200 W, or 20%
// above the current reading, so a strong day never pins the bar at 100%.
function solarPercent(watts: number): number {
  return Math.min(100, Math.round((watts / Math.max(200, watts * 1.2)) * 100));
}

// "−4.1 A · empty in ~39h · 13.42 V" — the battery's current, where it is
// heading, and its voltage, on the one line under the charge.
function batterySub(view: VanView): string | undefined {
  const { battery } = view.reading;
  if (!battery) return undefined;
  const eta = timeToFullOrEmpty({
    soc: battery.soc,
    capacityAh: battery.capacityAh,
    batA: battery.currentA,
  });
  const voltage = battery.cellSumV ?? battery.packVoltageV;
  return [
    formatAmps(battery.currentA),
    eta
      ? `${eta.direction === "full" ? "full" : "empty"} in ${formatEta(eta.hours)}`
      : "idle",
    `${voltage.toFixed(2)} V`,
  ].join(" · ");
}

export function panelColumns(view: VanView): PanelColumn[] {
  const { battery, solar } = view.reading;
  const columns: PanelColumn[] = [];
  if (battery) {
    columns.push({
      label: "Battery",
      value: battery.soc,
      unit: "%",
      percent: battery.soc,
      gauge: "battery",
      color: thresholdColor(battery.soc, {
        invert: true,
        lowBoundary: 20,
        highBoundary: 40,
      }),
      sub: batterySub(view),
    });
  }
  if (solar) {
    const sub = [
      solar.stateLabel,
      solar.yieldWh != null ? `${formatYield(solar.yieldWh)} today` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    columns.push({
      label: "Solar",
      value: solar.solarW,
      unit: "W",
      percent: solar.solarW != null ? solarPercent(solar.solarW) : 0,
      color: RAYCAST_COLOR.yellow,
      sub: sub || undefined,
    });
  }
  return columns;
}

// null when nothing could be read at all.
export function statusPanelImage(view: VanView): string | null {
  const columns = panelColumns(view);
  return columns.length > 0 ? toDataUri(statusPanel({ columns })) : null;
}

// Samples only exist when Van Power is opened, so the 3-day chart is honest
// about gaps: a reading further than this from its neighbour is not connected
// to it.
const CHARGE_GAP_MS = 3 * 3_600_000;

interface ChargePoints {
  times: number[];
  values: Array<number | null>;
  readings: number; // real samples, not the gap markers
}

// The 72 h charge samples with a `null` between every two readings more than
// CHARGE_GAP_MS apart — the chart breaks its line there instead of
// interpolating across hours nobody measured.
export function chargePoints(samples: Sample[], now: number): ChargePoints {
  const readings = recentSamples(samples, now).filter((s) => s.soc !== null);
  const times: number[] = [];
  const values: Array<number | null> = [];
  readings.forEach((s, i) => {
    const previous = readings[i - 1];
    if (previous && s.t - previous.t > CHARGE_GAP_MS) {
      times.push(previous.t + (s.t - previous.t) / 2);
      values.push(null);
    }
    times.push(s.t);
    values.push(s.soc);
  });
  return { times, values, readings: readings.length };
}

const AXIS_WIDTH = 56; // both stacked charts reserve it, so their plots line up

// The headline: the last 3 days as two stacked charts sharing one x axis, the
// night shading and the weekday labels (sunset → sunrise at `location`):
//   - Battery % on top, in the green gradient style: the charge **estimated**
//     by coulomb counting the Victron's charge current against an estimated house
//     load (see soc-estimate.ts — never a voltage-to-% conversion), pinned to our
//     own Ective readings, which
//     are drawn as solid dots; min / max / last chips, a 20 % low line;
//   - Solar W below, the charger's PV-power trend as a dense yellow area.
// With no trend, our readings alone draw the green line (once there are
// MIN_CHART_SAMPLES); with no readings, the estimate stands on its own. Null
// when there is nothing to draw.
export function chargeChartImage(opts: {
  samples: Sample[];
  trends: VictronTrends | null;
  now: number;
  location: Location;
  capacityAh?: number | null; // the BMS's capacity; 100 when unknown
}): string | null {
  const { samples, trends, now, location } = opts;
  const from = now - HISTORY_WINDOW_MS;
  const solar = solarPoints(trends).filter(([t]) => t >= from && t <= now);
  const readings = recentSamples(samples, now).flatMap((s) =>
    s.soc === null ? [] : [{ t: s.t, soc: s.soc, netA: s.batA }],
  );
  const estimate = estimateSoc({
    trends,
    captures: readings,
    from,
    to: now,
    capacityAh: opts.capacityAh,
  });
  const hasEstimate = estimate.some((p) => p.kind === "estimated");
  const own = chargePoints(samples, now);
  const hasBattery = hasEstimate || own.readings >= MIN_CHART_SAMPLES;

  const shared = {
    times: [] as number[],
    domain: [from, now] as [number, number],
    dayAxis: true,
    shading: nightSpans({ from, to: now, location }),
    axisWidth: AXIS_WIDTH,
  };
  const rows: string[] = [];

  if (hasBattery) {
    const line = hasEstimate ? socSeries(estimate) : own;
    rows.push(
      areaChart(
        {
          ...shared,
          hideXLabels: solar.length > 0,
          // measured readings: small solid dots, no per-dot text
          marks: hasEstimate
            ? readings.map((r) => ({
                t: r.t,
                v: r.soc,
                color: RAYCAST_COLOR.green,
              }))
            : [],
          series: [
            {
              label: hasEstimate
                ? "Battery · estimated from charge/discharge, ● measured"
                : "Battery charge",
              color: RAYCAST_COLOR.green,
              times: line.times,
              values: line.values,
              fill: true,
              extrema: true,
              domain: [0, 100] as [number, number],
              format: (v: number) => `${Math.round(v)}%`,
              reference: [
                { value: 20, label: "20% low", color: RAYCAST_COLOR.red },
              ],
            },
          ],
        },
        { height: 200 },
      ),
    );
  }

  if (solar.length > 0) {
    rows.push(
      areaChart(
        {
          ...shared,
          lastValues: false, // the panel above already says the current watts
          series: [
            {
              label: "Solar",
              color: RAYCAST_COLOR.yellow,
              times: solar.map(([t]) => t),
              values: solar.map(([, w]) => w),
              fill: true,
              format: (v: number) => `${Math.round(v)} W`,
            },
          ],
        },
        { height: hasBattery ? 150 : 190 },
      ),
    );
  }

  if (rows.length === 0) return null;
  return toDataUri(rows.length === 1 ? rows[0] : heroRows(rows, { gap: 0 }));
}

// ─── Victron on-device history (30 days of daily records) ──────────────────

const HISTORY_BAR_DAYS = 14;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "Mon" / "27" — spelled out here, not toLocaleDateString, so the axis does
// not depend on the ICU data of whichever JS engine runs it.
function axisLabel(date: string): { label: string; sublabel: string } {
  const [y, m, d] = date.split("-").map(Number);
  return {
    label: WEEKDAYS[new Date(y, m - 1, d).getDay()],
    sublabel: String(d),
  };
}

// Oldest → newest, as drawn.
function chronological(history: VictronHistory): VictronDay[] {
  return [...history.days].sort((a, b) => a.vreg - b.vreg).reverse();
}

// Complete days only: today is still being harvested and would drag the
// average down.
function dailyAverageWh(days: VictronDay[]): number {
  const complete = days.length >= 3 ? days.slice(0, -1) : days;
  return complete.reduce((sum, d) => sum + d.yieldWh, 0) / complete.length;
}

// Daily solar yield, last 14 days: today bold on the axis, only the best day
// labelled, a subtle dashed average. Null when there is nothing worth a chart.
export function yieldChartImage(history: VictronHistory | null): string | null {
  if (!history || history.days.length < 2) return null;
  const days = chronological(history).slice(-HISTORY_BAR_DAYS);
  const average = dailyAverageWh(days);
  return toDataUri(
    barChart({
      items: days.map((d) => ({ ...axisLabel(d.date), value: d.yieldWh })),
      color: RAYCAST_COLOR.yellow,
      format: formatYield,
      highlight: "last",
      dim: false,
      labelMode: "max",
      threshold: {
        value: average,
        label: `avg ${formatYield(Math.round(average))}`,
      },
    }),
  );
}

// "35.5 kWh in 30 days" for the yield heading — the one number the bars do not
// draw. Null without history.
export function yieldTotalText(history: VictronHistory | null): string | null {
  if (!history || history.days.length === 0) return null;
  const total = history.days.reduce((sum, d) => sum + d.yieldWh, 0);
  const kwh = (total / 1000).toFixed(total >= 10_000 ? 1 : 2);
  return `${kwh} kWh in ${history.days.length} days`;
}
