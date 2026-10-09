// Hero images for the Claude Usage view — pure (no @raycast/api), so the unit
// tests and `make previews` render exactly what the command embeds.

import { utcFormat, utcParse } from "d3-time-format";
import {
  PanelColumn,
  RAYCAST_COLOR,
  RaycastColor,
  StatCard,
  barChart,
  statCards,
  statusPanel,
  thresholdColor,
  toDataUri,
} from "../lib/svg";
import { spendSince, topLanesWithOther } from "./aggregate";
import {
  formatPercent,
  formatRelativeReset,
  formatSpend,
  formatWeekdayTime,
  modelLimitLabel,
} from "./format";
import {
  PaceStatus,
  QuotaLimits,
  QuotaWindow,
  WEEK_SECONDS,
  WeeklyPace,
  weeklyPace,
} from "./limits";
import { SpendAggregate } from "./types";

// Keeps the lane chart to 6 rows max (5 lanes + "other") — argo tracks ~60
// lanes, almost all zero on a given day; a handful of big rows reads better
// than a dense list of small ones.
const SPEND_LANE_LIMIT = 5;
const PANEL_COLUMNS = 3;

const PACE_COLOR: Record<PaceStatus, RaycastColor | null> = {
  early: null,
  "on-track": RAYCAST_COLOR.green,
  tight: RAYCAST_COLOR.orange,
  ahead: RAYCAST_COLOR.red,
};

function resetSub(window: QuotaWindow, nowMs: number): string {
  if (window.resetsAt === null) return "no reset time";
  return `resets in ${formatRelativeReset(window.resetsAt, nowMs)}`;
}

function percentColumn(
  label: string,
  window: QuotaWindow,
  sub: string,
  color?: RaycastColor,
): PanelColumn {
  return {
    label,
    value: window.percent === null ? null : Math.round(window.percent),
    unit: "%",
    percent: window.percent ?? 0,
    color: color ?? thresholdColor(window.percent ?? 0),
    sub,
  };
}

// Weekly first and biggest — on a Max plan it is the limit that binds — with
// a tick at the share of the week already gone: fill past the tick = ahead of
// pace. Then the 5h session, then the model caps the endpoint names (Fable
// today), as many as fit.
export function quotaPanel(limits: QuotaLimits, nowMs: number): string {
  const { weekly, session, models } = limits;
  const pace = weeklyPace(weekly, nowMs / 1000);
  const weeklyColumn: PanelColumn = {
    ...percentColumn(
      "Weekly",
      weekly,
      weekly.resetsAt === null
        ? "no reset time"
        : `resets ${formatWeekdayTime(weekly.resetsAt)} · in ${formatRelativeReset(weekly.resetsAt, nowMs)}`,
      (pace && PACE_COLOR[pace.status]) ?? undefined,
    ),
    marker: pace?.elapsed,
  };
  const modelColumns = models.map((model) =>
    percentColumn(
      modelLimitLabel(model),
      model,
      model.shareOfWeekly != null
        ? `cap = ${Math.round(model.shareOfWeekly)}% of weekly`
        : resetSub(model, nowMs),
    ),
  );
  return toDataUri(
    statusPanel({
      columns: [
        weeklyColumn,
        percentColumn("5h session", session, resetSub(session, nowMs)),
        ...modelColumns,
      ].slice(0, PANEL_COLUMNS),
    }),
  );
}

function paceCard(pace: WeeklyPace | null): StatCard {
  if (!pace || pace.projected === null)
    return { label: "At reset", value: "too early" };
  if (pace.status === "ahead" && pace.runsOutAt !== null)
    return {
      label: "Runs out",
      value: formatWeekdayTime(pace.runsOutAt),
      tone: "bad",
    };
  return {
    label: "At reset",
    value: pace.projected > 999 ? ">999%" : `~${Math.round(pace.projected)}%`,
    tone: pace.status === "tight" ? "warn" : "good",
  };
}

// Pace and the spend numbers, one quiet row. Pace: where the weekly limit ends
// at this week's rate, or when it runs out. Spend: today against the average
// complete day, and this quota week so far (from the weekly window's start).
export function usageMetrics(opts: {
  limits: QuotaLimits;
  spend: SpendAggregate | null;
  nowMs: number;
}): string {
  const { limits, spend, nowMs } = opts;
  const pace = weeklyPace(limits.weekly, nowMs / 1000);
  const cards: StatCard[] = [
    paceCard(pace),
    {
      label: "Week gone",
      value: pace ? formatPercent(pace.elapsed) : null,
    },
  ];
  if (spend) {
    const history = spend.dailyTotals.slice(0, -1).map((d) => d.total);
    const average =
      history.reduce((sum, v) => sum + v, 0) / (history.length || 1);
    cards.push({
      label: "Today",
      value: formatSpend(spend.todayTotal),
      delta: spendDelta(spend.todayTotal - average, history.length >= 3),
    });
    cards.push(
      limits.weekly.resetsAt === null
        ? { label: "7 days", value: formatSpend(spend.sevenDayTotal) }
        : {
            label: "This week",
            value: formatSpend(
              spendSince(
                spend.dailyTotals,
                limits.weekly.resetsAt - WEEK_SECONDS,
              ),
            ),
          },
    );
  }
  return toDataUri(statCards({ cards, size: "compact" }));
}

// Spending more than the daily average is the bad direction.
function spendDelta(
  difference: number,
  meaningful: boolean,
): StatCard["delta"] {
  if (!meaningful) return undefined;
  const direction =
    Math.abs(difference) < 0.005 ? "flat" : difference > 0 ? "up" : "down";
  return {
    value: `${formatSpend(Math.abs(difference))} vs avg`,
    direction,
    good: direction === "flat" ? undefined : difference < 0,
  };
}

const parseDay = utcParse("%Y-%m-%d");
const weekday = utcFormat("%a");
const dayOfMonth = utcFormat("%-d");
// Days before the current quota week, drawn quieter than the week itself.
const BEFORE_WEEK_STRENGTH = 0.45;

export function spendHeroes(
  spend: SpendAggregate,
  weekStartSeconds: number | null,
): {
  lanes: string;
  days: string;
} {
  const lanes = barChart({
    items: topLanesWithOther(spend.today, SPEND_LANE_LIMIT),
    orientation: "horizontal",
    format: formatSpend,
  });

  const weekStartDay =
    weekStartSeconds === null
      ? null
      : new Date(weekStartSeconds * 1000).toISOString().slice(0, 10);
  const history = spend.dailyTotals.slice(0, -1).map((d) => d.total);
  const average =
    history.reduce((sum, v) => sum + v, 0) / (history.length || 1);
  const days = barChart({
    items: spend.dailyTotals.map((d) => {
      const date = parseDay(d.bucket);
      return {
        label: date ? weekday(date) : d.bucket,
        sublabel: date ? dayOfMonth(date) : undefined,
        value: d.total,
        opacity:
          weekStartDay !== null && d.bucket < weekStartDay
            ? BEFORE_WEEK_STRENGTH
            : undefined,
      };
    }),
    format: formatSpend,
    highlight: "last",
    dim: false,
    labelMode: "extremes",
    threshold:
      history.length >= 3
        ? { value: average, label: `avg ${formatSpend(average)}` }
        : undefined,
  });

  return { lanes: toDataUri(lanes), days: toDataUri(days) };
}

// The chart heading's number: the whole window's spend.
export function periodTotal(spend: SpendAggregate): number {
  return spend.dailyTotals.reduce((sum, d) => sum + d.total, 0);
}
