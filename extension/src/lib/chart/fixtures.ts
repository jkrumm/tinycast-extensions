// Deterministic, realistic data for the chart library's tests, bench and
// `make previews` — plain arrays (no feature types), seeded so a render is
// reproducible. Not imported by any command.

// mulberry32 — a tiny seeded PRNG.
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function timeAxis(opts: {
  end: number;
  spanMs: number;
  count: number;
}): number[] {
  const { end, spanMs, count } = opts;
  return Array.from(
    { length: count },
    (_, i) => end - spanMs + (spanMs * i) / Math.max(count - 1, 1),
  );
}

export interface VanFixture {
  times: number[];
  soc: number[]; // %
  solarW: number[];
  batteryA: number[]; // + charging, − discharging
}

// A believable camper-van window: sun lifts the pack by day, a steady load
// drains it at night, clouds come and go.
export function vanFixture(opts: {
  end: number;
  hours: number;
  count: number;
  seed?: number;
}): VanFixture {
  const random = seeded(opts.seed ?? 7);
  const times = timeAxis({
    end: opts.end,
    spanMs: opts.hours * 3_600_000,
    count: opts.count,
  });
  const stepHours = opts.hours / Math.max(opts.count - 1, 1);
  const capacityAh = 195;
  let soc = 72;
  const out: VanFixture = { times, soc: [], solarW: [], batteryA: [] };
  let cloud = 1;
  for (const t of times) {
    const d = new Date(t);
    const hour = d.getHours() + d.getMinutes() / 60;
    const sun = Math.max(0, Math.sin(((hour - 6) / 14) * Math.PI)) ** 1.4;
    cloud = Math.min(1, Math.max(0.25, cloud + (random() - 0.5) * 0.5));
    const solarW = Math.round(sun * cloud * 280);
    const load = 3.2 + random() * 1.4;
    const batteryA = Math.round((solarW / 13.6 - load) * 10) / 10;
    soc = Math.min(
      100,
      Math.max(12, soc + ((batteryA * stepHours) / capacityAh) * 100),
    );
    out.soc.push(Math.round(soc));
    out.solarW.push(solarW);
    out.batteryA.push(batteryA);
  }
  return out;
}

// Daily spend totals, newest last — a few cheap days and a spike.
export function dailySpend(opts: { days: number; seed?: number }): number[] {
  const random = seeded(opts.seed ?? 3);
  return Array.from(
    { length: opts.days },
    (_, i) =>
      Math.round((2 + random() * 5 + (i % 5 === 3 ? 4 : 0)) * 100) / 100,
  );
}

export interface SpeedFixture {
  times: number[];
  download: number[];
  upload: Array<number | null>;
}

// Speed-test history: irregular spacing, upload missing on quick tests.
export function speedFixture(opts: {
  end: number;
  count: number;
  seed?: number;
}): SpeedFixture {
  const random = seeded(opts.seed ?? 11);
  const times: number[] = [];
  let t = opts.end;
  for (let i = 0; i < opts.count; i++) {
    times.unshift(t);
    t -= (0.3 + random() * 2.5) * 3_600_000 * (random() > 0.8 ? 12 : 1);
  }
  return {
    times,
    download: times.map(() => Math.round(35 + random() * 110)),
    upload: times.map(() =>
      random() > 0.45 ? Math.round(8 + random() * 30) : null,
    ),
  };
}
