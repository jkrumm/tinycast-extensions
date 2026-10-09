import { describe, expect, it } from "vitest";
import {
  INITIAL_SAMPLER_STATE,
  SamplerState,
  alertStep,
  alertText,
  applyRun,
  classifyRead,
  formatSamplerSubtitle,
  migrateSamplerState,
  samplerStatusLine,
} from "./sampler";
import {
  HELPER_BATTERY_BUSY,
  HELPER_BLUETOOTH_OFF,
  HELPER_FULL,
} from "./fixtures";
import { toReading } from "./parse";
import { HelperResult } from "./types";

const NOW = new Date(2026, 9, 9, 12, 40).getTime();
const read = (helper: HelperResult) => ({
  helper,
  reading: toReading({ helper, keyMissing: false, now: NOW }),
});

describe("classifyRead", () => {
  it("a BMS reading is a sample, with its charge", () => {
    expect(classifyRead(read(HELPER_FULL))).toEqual({
      kind: "sampled",
      soc: 98,
    });
  });

  it("the phone app holding the BMS says so, even though the charger was heard", () => {
    expect(classifyRead(read(HELPER_BATTERY_BUSY))).toEqual({
      kind: "phone-app",
    });
  });

  it("nothing found is out of range; Bluetooth trouble is named", () => {
    expect(
      classifyRead(
        read({
          battery: null,
          victron: null,
          errors: ["battery-not-found", "victron-not-found"],
        }),
      ),
    ).toEqual({ kind: "not-in-range" });
    expect(classifyRead(read(HELPER_BLUETOOTH_OFF))).toEqual({
      kind: "bluetooth",
      detail: "off",
    });
  });
});

describe("alertStep", () => {
  it("fires once when the charge reaches 30 %, not again while it stays low", () => {
    let step = alertStep([], 31);
    expect(step).toEqual({ fire: null, latched: [] });
    step = alertStep(step.latched, 30);
    expect(step).toEqual({ fire: 30, latched: [30] });
    step = alertStep(step.latched, 27);
    expect(step).toEqual({ fire: null, latched: [30] });
  });

  it("fires 15 % separately, after the 30 % one", () => {
    let step = alertStep([], 28);
    step = alertStep(step.latched, 15);
    expect(step).toEqual({ fire: 15, latched: [30, 15] });
    expect(alertStep(step.latched, 12).fire).toBeNull();
  });

  it("a reading that jumps through both reports only the lowest", () => {
    expect(alertStep([], 12)).toEqual({ fire: 15, latched: [30, 15] });
  });

  it("re-arms only once the charge is 5 points above the threshold", () => {
    let step = alertStep([], 28);
    step = alertStep(step.latched, 34); // above the line, not yet re-armed
    expect(step.latched).toEqual([30]);
    expect(alertStep(step.latched, 29).fire).toBeNull(); // wobble: still quiet
    step = alertStep(step.latched, 35); // 30 + 5
    expect(step).toEqual({ fire: null, latched: [] });
    expect(alertStep(step.latched, 29).fire).toBe(30); // a new crossing
  });

  it("re-arms each threshold on its own", () => {
    const step = alertStep([30, 15], 21);
    expect(step.latched).toEqual([30]); // 15 released (≥ 20), 30 held
  });

  it("words the alert for the threshold", () => {
    expect(alertText(28.4, 30)).toBe(
      "Van battery 28 % — stop charging devices from the van",
    );
    expect(alertText(14, 15)).toContain("critically low");
  });
});

describe("applyRun", () => {
  const sampled = (soc: number | null) => ({ kind: "sampled", soc }) as const;

  it("records the run and posts an alert on a crossing, then stays quiet", () => {
    const first = applyRun(INITIAL_SAMPLER_STATE, {
      now: NOW,
      result: sampled(29),
    });
    expect(first.alert).toEqual({
      threshold: 30,
      text: "Van battery 29 % — stop charging devices from the van",
    });
    expect(first.state).toMatchObject({
      lastRunAt: NOW,
      lastResult: { kind: "sampled", soc: 29 },
      lastAlert: { latched: [30], threshold: 30, at: NOW },
    });
    const second = applyRun(first.state, {
      now: NOW + 900_000,
      result: sampled(28),
    });
    expect(second.alert).toBeNull();
    expect(second.state.lastAlert).toEqual(first.state.lastAlert);
  });

  it("keeps the last alert's record when the charge recovers and re-arms", () => {
    const low = applyRun(INITIAL_SAMPLER_STATE, {
      now: NOW,
      result: sampled(29),
    }).state;
    const back = applyRun(low, { now: NOW + 1, result: sampled(40) }).state;
    expect(back.lastAlert).toEqual({ latched: [], threshold: 30, at: NOW });
  });

  it("an unreadable run never alerts and leaves the latches alone", () => {
    const low = applyRun(INITIAL_SAMPLER_STATE, {
      now: NOW,
      result: sampled(29),
    }).state;
    for (const result of [
      { kind: "not-in-range" },
      { kind: "phone-app" },
      { kind: "error", message: "boom" },
      sampled(null),
    ] as const) {
      const next = applyRun(low, { now: NOW + 1, result });
      expect(next.alert).toBeNull();
      expect(next.state.lastAlert).toEqual(low.lastAlert);
      expect(next.state.lastResult).toEqual(result);
    }
  });
});

describe("words", () => {
  const state = (over: Partial<SamplerState>): SamplerState => ({
    ...INITIAL_SAMPLER_STATE,
    ...over,
  });

  it("subtitle: charge and time, or what went wrong, or Paused", () => {
    expect(
      formatSamplerSubtitle(
        state({ lastRunAt: NOW, lastResult: { kind: "sampled", soc: 83 } }),
      ),
    ).toBe("83 % · 12:40");
    expect(
      formatSamplerSubtitle(
        state({ lastRunAt: NOW, lastResult: { kind: "not-in-range" } }),
      ),
    ).toBe("Van not in range");
    expect(
      formatSamplerSubtitle(
        state({ lastRunAt: NOW, lastResult: { kind: "phone-app" } }),
      ),
    ).toBe("Phone app holds the battery");
    expect(formatSamplerSubtitle(state({ paused: true }))).toBe("Paused");
    expect(formatSamplerSubtitle(state({}))).toBe("Not run yet");
  });

  it("status line for the view", () => {
    expect(samplerStatusLine(state({}))).toBe(
      "Background sampling every 15 min",
    );
    expect(
      samplerStatusLine(
        state({ lastRunAt: NOW, lastResult: { kind: "sampled", soc: 83 } }),
      ),
    ).toBe("Background sampling every 15 min · last 12:40");
    expect(
      samplerStatusLine(
        state({ lastRunAt: NOW, lastResult: { kind: "not-in-range" } }),
      ),
    ).toBe("Background sampling every 15 min · last 12:40: van not in range");
    expect(samplerStatusLine(state({ paused: true }))).toBe(
      "Background sampling paused",
    );
  });
});

describe("migrateSamplerState", () => {
  it("defaults to active, and survives junk", () => {
    expect(migrateSamplerState(null)).toEqual(INITIAL_SAMPLER_STATE);
    expect(migrateSamplerState({ paused: "yes", lastRunAt: "x" })).toEqual(
      INITIAL_SAMPLER_STATE,
    );
  });

  it("keeps what a valid state holds", () => {
    const valid: SamplerState = {
      paused: true,
      lastRunAt: NOW,
      lastResult: { kind: "sampled", soc: 40 },
      lastAlert: { latched: [30], threshold: 30, at: NOW },
    };
    expect(migrateSamplerState(JSON.parse(JSON.stringify(valid)))).toEqual(
      valid,
    );
  });
});
