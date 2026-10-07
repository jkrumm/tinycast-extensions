// Hero images for the Claude Usage view — pure (no @raycast/api), so the unit
// tests and `make previews` render exactly what the command embeds.

import { utcFormat, utcParse } from "d3-time-format";
import {
  StatCard,
  barChart,
  ringGaugeRow,
  statCards,
  toDataUri,
} from "../lib/svg";
import { topLanesWithOther } from "./aggregate";
import { formatRelativeReset, formatSpend } from "./format";
import { SpendAggregate, UsageQuotaOk } from "./types";

// Keeps the lane chart to 6 rows max (5 lanes + "other") — argo tracks ~60
// lanes, almost all zero on a given day; a handful of big rows reads better
// than a dense list of small ones.
const SPEND_LANE_LIMIT = 5;

export function quotaHero(quota: UsageQuotaOk): string {
  const reset = (epoch: number | null) =>
    `resets in ${formatRelativeReset(epoch)}`;
  return toDataUri(
    ringGaugeRow([
      {
        percent: quota.five_hour.utilization ?? 0,
        label: "5h",
        sublabel: reset(quota.five_hour.resets_at_epoch),
      },
      {
        percent: quota.seven_day.utilization ?? 0,
        label: "7d",
        sublabel: reset(quota.seven_day.resets_at_epoch),
      },
      {
        percent: quota.seven_day_sonnet.utilization ?? 0,
        label: "7d Sonnet",
        sublabel: reset(quota.seven_day_sonnet.resets_at_epoch),
      },
    ]),
  );
}

const parseDay = utcParse("%Y-%m-%d");
const weekday = utcFormat("%a");

export function spendHeroes(spend: SpendAggregate): {
  lanes: string;
  days: string;
} {
  const lanes = barChart({
    items: topLanesWithOther(spend.today, SPEND_LANE_LIMIT),
    orientation: "horizontal",
    format: formatSpend,
  });

  const totals = spend.dailyTotals.map((d) => d.total);
  const average = totals.reduce((sum, v) => sum + v, 0) / (totals.length || 1);
  const days = barChart({
    items: spend.dailyTotals.map((d) => {
      const date = parseDay(d.bucket);
      return { label: date ? weekday(date) : d.bucket, value: d.total };
    }),
    format: formatSpend,
    highlight: "last",
    threshold:
      totals.length >= 3
        ? { value: average, label: `avg ${formatSpend(average)}` }
        : undefined,
  });

  return { lanes: toDataUri(lanes), days: toDataUri(days) };
}

// Today against the daily average, and the 7-day total — the two numbers the
// lane chart and the day bars only imply (no sparkline: the day bars below are
// that trend).
export function totalsCards(spend: SpendAggregate): string {
  const totals = spend.dailyTotals.map((d) => d.total);
  const average = totals.reduce((sum, v) => sum + v, 0) / (totals.length || 1);
  const cards: StatCard[] = [
    {
      label: "Today",
      value: formatSpend(spend.todayTotal),
      delta: spendDelta(spend.todayTotal - average, totals.length >= 3),
    },
    { label: "7 days", value: formatSpend(spend.sevenDayTotal) },
  ];
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
