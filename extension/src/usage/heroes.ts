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
import { SESSION_LIMIT } from "./routing";
import {
  AccountSummary,
  UsageSummary,
  accountProblem,
  paceWords,
} from "./summary";
import { IuBudgetView, BudgetState, usd0 } from "./iu-budget";
import { SpendAggregate } from "./types";

// Keeps the lane chart to 6 rows max (5 lanes + "other") — argo tracks ~60
// lanes, almost all zero on a given day; a handful of big rows reads better
// than a dense list of small ones.
const SPEND_LANE_LIMIT = 5;
// `statusPanel` itself hard-caps at 3 columns (lib/chart/cards.ts) — a row
// wider than that would just get silently truncated there too.
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

// The top of the multi-account Detail: the pool first (weighted weekly use
// across every account, with how much capacity is left in plan units), then
// one column per account — weekly use with the week-elapsed tick (fill past it
// = ahead of pace), and under it where the week is heading, or why this Mac's
// picker would skip the account. More columns than fit one panel row wrap
// into additional rows — one `statusPanel` image each — rather than dropping
// an account.
export function capacityPanel(summary: UsageSummary): string[] {
  const columns: PanelColumn[] = [];
  const { pool } = summary;
  if (pool) {
    const units = (n: number) =>
      Number.isInteger(n) ? String(n) : n.toFixed(1);
    columns.push({
      label: pool.weighted ? "Pool" : "Pool · equal weights",
      value: Math.round(pool.usedPct),
      unit: "%",
      percent: pool.usedPct,
      color: thresholdColor(pool.usedPct),
      marker: pool.elapsedPct ?? undefined,
      sub: pool.weighted
        ? `${units(pool.left)}x of ${units(pool.total)}x left`
        : `${Math.round(100 - pool.usedPct)}% left`,
    });
  }
  for (const a of summary.accounts) {
    const flagged = a.flags.length > 0 || !a.eligibility.eligible;
    // Greyed: the account cannot be used for a reason other than being full
    // (a full account keeps its red).
    const greyed =
      a.weeklyPct === null ||
      a.flags.length > 0 ||
      (!a.eligibility.eligible && !a.eligibility.reason?.includes("≥"));
    columns.push({
      label: [a.id, a.plan, a.working ? "working" : null]
        .filter(Boolean)
        .join(" · "),
      value: a.weeklyPct === null ? null : Math.round(a.weeklyPct),
      unit: "%",
      percent: a.weeklyPct ?? 0,
      color: greyed
        ? RAYCAST_COLOR.secondaryText
        : ((a.pace && PACE_COLOR[a.pace.status]) ??
          thresholdColor(a.weeklyPct ?? 0)),
      marker: a.pace?.elapsed,
      sub: accountSub(a, flagged),
    });
  }
  if (columns.length === 0) return [toDataUri(statusPanel({ columns: [] }))];
  const rows: string[] = [];
  for (let i = 0; i < columns.length; i += PANEL_COLUMNS) {
    rows.push(
      toDataUri(statusPanel({ columns: columns.slice(i, i + PANEL_COLUMNS) })),
    );
  }
  return rows;
}

function accountSub(a: AccountSummary, flagged: boolean): string {
  if (flagged) {
    const problem = accountProblem(a);
    return problem ?? `not pickable: ${a.eligibility.reason ?? "unknown"}`;
  }
  const pace = paceWords(a.pace, formatWeekdayTime);
  return a.weeklyResetsAt === null
    ? pace
    : `${pace} · resets ${formatWeekdayTime(a.weeklyResetsAt)}`;
}

// The quiet row under the panel: each account's 5h window (the limit that
// gates the next spawn), then spend today against the daily average and the
// last 7 days.
export function capacityMetrics(opts: {
  summary: UsageSummary;
  spend: SpendAggregate | null;
  nowMs: number;
}): string {
  const { summary, spend, nowMs } = opts;
  const cards: StatCard[] = summary.accounts.map((a) => ({
    label: `${a.id} 5h`,
    value:
      a.fiveHourPct === null
        ? null
        : `${Math.round(a.fiveHourPct)}% · ${formatRelativeReset(a.fiveHourResetsAt, nowMs)}`,
    tone:
      a.fiveHourPct !== null && a.fiveHourPct >= SESSION_LIMIT
        ? "bad"
        : undefined,
  }));
  if (spend) {
    const history = spend.dailyTotals.slice(0, -1).map((d) => d.total);
    const average =
      history.reduce((sum, v) => sum + v, 0) / (history.length || 1);
    cards.push(
      {
        label: "Today",
        value: formatSpend(spend.todayTotal),
        delta: spendDelta(spend.todayTotal - average, history.length >= 3),
      },
      { label: "7 days", value: formatSpend(spend.sevenDayTotal) },
    );
  }
  return toDataUri(
    statCards({ cards, size: "compact", columns: Math.min(cards.length, 6) }),
  );
}

export const BUDGET_COLOR: Record<BudgetState, RaycastColor> = {
  ok: RAYCAST_COLOR.green,
  warn: RAYCAST_COLOR.orange,
  over: RAYCAST_COLOR.red,
};

// The IU budget's daily spend (31 days from the portal). Days older than the
// 30-day window are drawn quieter; the dashed line is the even share of the
// cap per day, so a bar above it is a day that ate into the budget.
export function iuBudgetChart(view: IuBudgetView): string {
  const { daily, windowDays } = view.data;
  const outside = Math.max(0, daily.length - windowDays);
  return toDataUri(
    barChart({
      items: daily.map((d, i) => {
        const date = parseDay(d.day);
        return {
          label: date ? weekday(date) : d.day,
          sublabel: date ? dayOfMonth(date) : undefined,
          value: d.usd,
          opacity: i < outside ? BEFORE_WEEK_STRENGTH : undefined,
        };
      }),
      color: BUDGET_COLOR[view.state],
      format: usd0,
      highlight: "last",
      dim: false,
      labelMode: "extremes",
      threshold: {
        value: view.perDayUsd,
        label: `${usd0(view.data.limitUsd)}/${windowDays} = ${formatSpend(view.perDayUsd)}/day`,
      },
    }),
  );
}
