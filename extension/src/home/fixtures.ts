// Deterministic, realistic climate data for the tests, the legibility checks
// and `make previews` — a cold-snap November flat in Munich. Not imported by
// any command.

import { seeded } from "../lib/chart/fixtures";
import { ClimatePoint } from "./climate";
import { StatusCache } from "./types";

const STEP_MS = 10 * 60_000;

// One point per 10 minutes, oldest first. Outside follows the day (cold at
// dawn, mild and drier at lunch) on a slow weather drift; inside is held by
// the heating, with a cooking/shower humidity spike every evening and a
// window-open dip. A short stretch of missing readings shows a gap.
export function climateFixture(opts: {
  end: number;
  hours: number;
  seed?: number;
}): ClimatePoint[] {
  const random = seeded(opts.seed ?? 5);
  const count = Math.floor((opts.hours * 3_600_000) / STEP_MS) + 1;
  const points: ClimatePoint[] = [];
  let drift = 0;
  for (let i = 0; i < count; i++) {
    const at = opts.end - (count - 1 - i) * STEP_MS;
    const d = new Date(at);
    const hour = d.getHours() + d.getMinutes() / 60;
    const day = Math.sin(((hour - 9) / 24) * 2 * Math.PI);
    drift += (random() - 0.5) * 0.12;
    drift = Math.max(-5, Math.min(5, drift));
    const weather = 4 * Math.sin((i / (5 * 144)) * 2 * Math.PI);
    const outT = 5 + drift + weather + day * 3.2;
    const outH = Math.min(97, Math.max(45, 78 - day * 14 + drift * 2));
    const evening = Math.exp(-(((hour - 19.5) / 1.1) ** 2));
    const airingDip = Math.exp(-(((hour - 8) / 0.4) ** 2));
    const inT =
      21.6 + day * 0.5 + evening * 0.6 - airingDip * 1.4 + random() * 0.15;
    const inH =
      42 + evening * 17 - airingDip * 7 + (outH - 75) * 0.12 + random();
    const missing = i % 700 > 690;
    points.push({
      at,
      inT: missing ? null : round1(inT),
      inH: missing ? null : Math.round(inH),
      outT: round1(outT),
      outH: Math.round(outH),
    });
  }
  return points;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function statusCacheFixture(now: number): StatusCache {
  return {
    status: {
      climate: {
        sensor: "Eve Room CF8D",
        reachable: true,
        temperatureC: 21.9,
        humidityPct: 42,
        batteryPct: 100,
      },
      namiHome: true,
      someoneHome: true,
    },
    fetchedAt: now - 3 * 60_000,
    climateAt: now - 3 * 60_000,
  };
}
