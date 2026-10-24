// Every production hero, built by the exact functions the commands embed, from
// the fixtures in `fixtures.ts`. One list shared by svg.test.ts (legibility,
// well-formedness, perf) and `make previews`, so a hero added to a command and
// to this list is checked and looked at everywhere. Not imported by any command.

import { aggregateSpend } from "../../usage/aggregate";
import {
  accountsPanel,
  quotaPanel,
  spendHeroes,
  usageMetrics,
} from "../../usage/heroes";
import { quotaLimits } from "../../usage/limits";
import {
  historyImage as speedHistory,
  metricsImage as speedMetrics,
  panelImage as speedPanel,
} from "../../speed-test/heroes";
import {
  metricsImage as batteryMetrics,
  panelImage as batteryPanel,
} from "../../battery/heroes";
import {
  chargeChartImage as vanCharge,
  consumptionChartImage as vanConsumption,
  statusPanelImage as vanPanel,
  yieldChartImage as vanYield,
} from "../../van/heroes";
import type { DayConsumption } from "../../van/consumption";
import { fixtureVictronAll } from "../../van/fixtures";
import { compactTrends } from "../../van/history";
import { estimateSoc } from "../../van/soc-estimate";
import type { Location } from "../../van/sun";
import {
  metricsImage as netgearMetrics,
  panelImage as netgearPanel,
} from "../../netgear/status-view";
import {
  panelImage as signalPanel,
  trendImage as signalTrend,
} from "../../netgear/signal-view";
import type { SignalSample } from "../../netgear/signal-view";
import type { AccountQuota, UsageQuotaOk } from "../../usage/types";
import type { SpeedTestRecord } from "../../speed-test/types";
import type { BatterySnapshot } from "../../battery/types";
import type { RouterStatus } from "../../netgear/types";
import type { Sample, VanView } from "../../van/types";
import { dailySpend, speedFixture, vanFixture } from "./fixtures";

export interface ProductionHero {
  group: string;
  name: string;
  svg: string;
}

export function decodeDataUri(uri: string): string {
  const [, rest] = uri.split(";base64,");
  return Buffer.from(rest.split("?")[0], "base64").toString("utf8");
}

const DAY = 86_400_000;

function batterySnapshot(opts: {
  percent: number;
  state: string;
  limited: boolean;
  watts: number;
}): BatterySnapshot {
  return {
    status: {
      charging: {
        allowCharging: true,
        useAdapter: true,
        pluggedIn: opts.state === "charging",
      },
      battery: {
        currentChargePercent: opts.percent,
        state: opts.state,
        timeToLimitMinutes: null,
        fullCapacityMah: 6000,
        chargeRateWatts: opts.watts,
        voltageVolts: 12.4,
      },
      configuration: {
        enabled: opts.limited,
        upperLimitPercent: 80,
        lowerLimitPercent: 75,
      },
      calibration: { phase: "" },
    },
    hardware: {
      cycleCount: 348,
      designCapacityMah: 6000,
      rawMaxCapacityMah: 5160,
      temperatureCelsius: 31,
    },
    pauseUntilEpoch: null,
  };
}

export function productionHeroes(now: number): ProductionHero[] {
  const heroes: ProductionHero[] = [];
  const add = (group: string, name: string, uri: string) =>
    heroes.push({ group, name, svg: decodeDataUri(uri) });

  // Max plan, 2026-10: weekly ahead of pace (62 % with ~45 % of the week
  // gone), the 5h session light, a Fable cap worth half the weekly.
  const weeklyReset = now / 1000 + 330_000;
  const quota: UsageQuotaOk = {
    five_hour: { utilization: 13, resets_at_epoch: now / 1000 + 4_080 },
    seven_day: { utilization: 62, resets_at_epoch: weeklyReset },
    seven_day_sonnet: { utilization: null, resets_at_epoch: null },
    limits: [
      {
        kind: "weekly_scoped",
        group: "weekly",
        label: "Fable",
        percent: 8,
        resets_at_epoch: weeklyReset,
        severity: "normal",
        is_active: false,
        allowance_percent_of_weekly: 50,
      },
    ],
    fetched_at: now / 1000,
  };
  const limits = quotaLimits(quota);
  add("usage", "usage-quota", quotaPanel(limits, now));
  const account = (
    id: string,
    plan: string,
    seven: number,
    authOk = true,
  ): AccountQuota => ({
    id,
    plan,
    fiveHourPct: 4,
    sevenDayPct: seven,
    fiveHourResetsAt: now / 1000 + 4_080,
    sevenDayResetsAt: weeklyReset,
    authOk,
    exhaustedUntil: null,
    updatedAt: now / 1000,
  });
  add(
    "usage",
    "usage-accounts",
    accountsPanel(
      [account("iu", "max20x", 62), account("me", "max5x", 8, false)],
      now,
    ),
  );

  const totals = dailySpend({ days: 30 });
  const spend = aggregateSpend({
    groupKeys: [
      "claude-code",
      "codex",
      "opencode",
      "warden",
      "sideclaw",
      "hermes",
      "tinycast",
    ],
    buckets: totals.map((total, i) => ({
      bucket: new Date(now - (totals.length - 1 - i) * DAY)
        .toISOString()
        .slice(0, 10),
      groups: (i === totals.length - 1
        ? {
            "claude-code": 4.82,
            codex: 2.1,
            opencode: 1.4,
            warden: 0.92,
            sideclaw: 0.61,
            hermes: 0.3,
            tinycast: 0.25,
          }
        : { "claude-code": total * 0.7, codex: total * 0.3 }) as Record<
        string,
        number
      >,
    })),
  });
  const spendImages = spendHeroes(spend, weeklyReset - 7 * 24 * 3600);
  add("usage", "usage-metrics", usageMetrics({ limits, spend, nowMs: now }));
  add("usage", "usage-lanes", spendImages.lanes);
  add("usage", "usage-days", spendImages.days);

  const fx = speedFixture({ end: now, count: 14 });
  const history: SpeedTestRecord[] = fx.times
    .map((timestamp, i): SpeedTestRecord => ({
      timestamp,
      full: fx.upload[i] !== null,
      dlMbps: fx.download[i],
      ulMbps: fx.upload[i],
      latencyMs: 42,
      responsiveness: 700,
      dataUsedMB: 40,
      interfaceName: "en0",
    }))
    .reverse();
  const full = {
    ...history[0],
    ulMbps: history[0].ulMbps ?? 22,
    responsiveness: 812,
    full: true,
  };
  const fullHistory = [full, ...history.slice(1)];
  add("speed", "speed-panel", speedPanel(full, fullHistory));
  add("speed", "speed-metrics", speedMetrics(full));
  add("speed", "speed-history", speedHistory(fullHistory)!);
  const quick = {
    ...history[0],
    ulMbps: null,
    responsiveness: null,
    full: false,
  };
  const quickHistory = history.map((r) => ({ ...r, ulMbps: null }));
  add("speed", "speed-panel-quick", speedPanel(quick, quickHistory));
  add("speed", "speed-metrics-quick", speedMetrics(quick));
  add("speed", "speed-history-quick", speedHistory(quickHistory)!);

  const charging = batterySnapshot({
    percent: 76,
    state: "charging",
    limited: true,
    watts: 22.4,
  });
  add("battery", "battery-panel", batteryPanel(charging));
  add("battery", "battery-metrics", batteryMetrics(charging));
  const low = batterySnapshot({
    percent: 18,
    state: "discharging",
    limited: false,
    watts: -9.8,
  });
  add("battery", "battery-panel-low", batteryPanel(low));
  add("battery", "battery-metrics-low", batteryMetrics(low));

  const van = vanFixture({ end: now, hours: 72, count: 170, seed: 21 });
  const samples: Sample[] = van.times.map((t, i) => ({
    t,
    soc: van.soc[i],
    batV: 13.4,
    batA: van.batteryA[i],
    cellMinV: 3.35,
    cellMaxV: 3.36,
    tempC: 24,
    pvW: van.solarW[i],
    chgA: van.solarW[i] / 13.6,
    loadA: 0,
    yieldWh: 420,
    state: "Bulk",
  }));
  const view = {
    reading: {
      battery: {
        soc: 82,
        cellSumV: 13.42,
        packVoltageV: 13.4,
        currentA: -4.1,
        capacityAh: 194.9,
        cycles: 407,
        tempC: 24.5,
        cellsMv: [3351, 3358, 3362, 3355],
        errorFlags: [],
      },
      solar: {
        solarW: 148,
        stateLabel: "Bulk",
        chargeA: 10.8,
        loadA: null,
        yieldWh: 1240,
      },
      issues: [],
      readAt: now,
    },
    samples,
  } as unknown as VanView;
  add("van", "van-panel", vanPanel(view)!);
  const berlin: Location = { lat: 52.52, lon: 13.405 };
  const victronAll = fixtureVictronAll(now);
  const trends = compactTrends(victronAll.trends);
  // What opening the command now and then really leaves behind: a burst of
  // readings (the live read + a refresh or two), then hours of nothing. The
  // fixture's own SoC is unrelated to the real voltage trend, so the readings
  // are the voltage-based estimate nudged by a few % — what a real BMS would
  // say — which shows the anchoring merging into them.
  const baseline = estimateSoc({
    trends: victronAll.trends,
    captures: [],
    from: now - 72 * 3_600_000,
    to: now,
  });
  const nearestBase = (t: number) =>
    baseline.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
      .soc;
  const nudge = [-7, 5, -4, 8, -6, 3, -5, 6, -3, 4, -6, 5];
  const reading = (sample: Sample, i: number): Sample => ({
    ...sample,
    soc: Math.max(
      0,
      Math.min(
        100,
        Math.round(nearestBase(sample.t) + nudge[i % nudge.length]),
      ),
    ),
  });
  const bursts = [8, 30, 33, 56, 59, 62, 93, 96, 128, 131, 134, 165].map(
    (i, k) => reading(samples[Math.min(i, samples.length - 1)], k),
  );
  add(
    "van",
    "van-charge",
    vanCharge({ samples: bursts, trends, now, location: berlin })!,
  );
  add(
    "van",
    "van-charge-dense",
    vanCharge({
      samples: samples.filter((_, i) => i % 6 === 0).map(reading),
      trends,
      now,
      location: berlin,
    })!,
  );
  // The background sampler: a reading every ~25 min for three days.
  add(
    "van",
    "van-charge-sampled",
    vanCharge({
      samples: samples.map(reading),
      trends,
      now,
      location: berlin,
    })!,
  );
  add(
    "van",
    "van-charge-solar-only",
    vanCharge({ samples: [], trends, now, location: berlin })!,
  );
  add("van", "van-yield", vanYield(victronAll.history)!);
  // A fortnight of the van: measured days around 30–45 Ah, a mixed one, two
  // resting on an estimate (muted), the gap of a day nobody looked, and today.
  const dayStart = (k: number) => {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - k).getTime();
  };
  const fortnight: Array<[number, number, DayConsumption["quality"]] | null> = [
    [38, 61, "measured"],
    [44, 70, "measured"],
    [29, 54, "measured"],
    [52, 33, "mixed"],
    [41, 12, "estimated"],
    null,
    [35, 66, "estimated"],
    [47, 58, "measured"],
    [31, 72, "measured"],
    [36, 64, "measured"],
    [58, 41, "mixed"],
    [33, 69, "measured"],
    [40, 63, "measured"],
    [19, 28, "measured"],
  ];
  const consumption = fortnight.map((day, i): DayConsumption | null =>
    day
      ? {
          dayStart: dayStart(fortnight.length - 1 - i),
          consumedAh: day[0],
          chargedAh: day[1],
          coverage: day[2] === "measured" ? 0.95 : day[2] === "mixed" ? 0.5 : 0,
          quality: day[2],
          partial: i === fortnight.length - 1,
        }
      : null,
  );
  add("van", "van-consumption", vanConsumption(consumption)!);

  const router = {
    radioQuality: 48,
    connection: "Connected",
    connectionText: "LTE+",
    band: "LTE B3",
    operator: "Orange",
    currentlyRoaming: true,
    battChargeLevel: 66,
    charging: true,
    dataTransferredGB: 14.2,
    uptimeSeconds: 3 * 86400 + 4 * 3600,
    connectedClients: 4,
    smsUnread: 2,
  } as RouterStatus;
  add("netgear", "netgear-panel", netgearPanel(router));
  add("netgear", "netgear-metrics", netgearMetrics(router, true));

  // The Signal Meter on a weak link, creeping up as the router is moved.
  const sinrWalk = [-3, -1, -2, 0, 2, 1, 3, 5, 4, 6, 9, 8, 11, 10, 12];
  const sinrSamples: SignalSample[] = sinrWalk.map((sinr, i) => ({
    at: now - (sinrWalk.length - 1 - i) * 2_000,
    sinr,
    rsrp: -102 + i,
    rsrq: -13,
    rssi: -70,
    band: "LTE B1",
    registered: true,
    cellId: "25480193",
    caSecondaryCells: 1,
    txLevel: 22,
    pingAvgMs: 320,
    lossPercent: 7.5,
  }));
  const meterNow = sinrSamples[sinrSamples.length - 1];
  add("netgear", "signal-panel", signalPanel(meterNow));
  add("netgear", "signal-panel-poor", signalPanel(sinrSamples[0]));
  add("netgear", "signal-trend", signalTrend(sinrSamples)!);

  return heroes;
}
