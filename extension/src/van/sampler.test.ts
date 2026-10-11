import { describe, expect, it } from "vitest";
import {
  INITIAL_SAMPLER_STATE,
  SamplerState,
  alertStep,
  alertText,
  applyRun,
  classifyRead,
  formatSamplerSubtitle,
  PAIRING_BACKOFF_MS,
  TRENDS_ATTEMPT_GAP_MS,
  TRENDS_STALE_MS,
  applyTrendsTopUp,
  migrateSamplerState,
  samplerStatusLine,
  trendsTopUpDue,
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
      lastTrendsAttemptAt: NOW - 60_000,
      trendsBackoffUntil: NOW + PAIRING_BACKOFF_MS,
      lastTrends: {
        at: NOW - 60_000,
        outcome: "pairing",
        detail: "victron-pairing-timeout",
      },
    };
    expect(migrateSamplerState(JSON.parse(JSON.stringify(valid)))).toEqual(
      valid,
    );
  });
});

describe("trendsTopUpDue", () => {
  const stale = NOW - TRENDS_STALE_MS - 60_000;
  const due = (over: Partial<SamplerState> = {}, trendsUpdatedAt = stale) =>
    trendsTopUpDue({
      state: { ...INITIAL_SAMPLER_STATE, ...over },
      victronHeard: true,
      trendsUpdatedAt,
      now: NOW,
    });

  it("is due when the cached trends are over 3 h old and the charger was heard", () => {
    expect(due()).toBe(true);
    expect(due({}, NOW - TRENDS_STALE_MS + 60_000)).toBe(false);
  });

  it("is not due out of range, or before any foreground read paired the Victron", () => {
    expect(
      trendsTopUpDue({
        state: INITIAL_SAMPLER_STATE,
        victronHeard: false,
        trendsUpdatedAt: stale,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      trendsTopUpDue({
        state: INITIAL_SAMPLER_STATE,
        victronHeard: true,
        trendsUpdatedAt: null,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("waits 3 h after the last attempt, a failure included", () => {
    expect(
      due({ lastTrendsAttemptAt: NOW - TRENDS_ATTEMPT_GAP_MS + 60_000 }),
    ).toBe(false);
    expect(
      due({ lastTrendsAttemptAt: NOW - TRENDS_ATTEMPT_GAP_MS - 60_000 }),
    ).toBe(true);
  });

  it("stays off for 24 h after a pairing error", () => {
    expect(due({ trendsBackoffUntil: NOW + 60_000 })).toBe(false);
    expect(due({ trendsBackoffUntil: NOW - 1 })).toBe(true);
  });
});

describe("applyTrendsTopUp", () => {
  it("records a success without a backoff", () => {
    const next = applyTrendsTopUp(INITIAL_SAMPLER_STATE, {
      now: NOW,
      reason: null,
    });
    expect(next.lastTrends).toEqual({ at: NOW, outcome: "ok", detail: null });
    expect(next.trendsBackoffUntil).toBeNull();
  });

  it("records a failure, and a pairing error also backs off 24 h", () => {
    const failed = applyTrendsTopUp(INITIAL_SAMPLER_STATE, {
      now: NOW,
      reason: "victron-connect-failed",
    });
    expect(failed.lastTrends?.outcome).toBe("failed");
    expect(failed.trendsBackoffUntil).toBeNull();
    for (const reason of [
      "victron-pairing-timeout",
      "x, victron-pairing-failed",
    ]) {
      const pairing = applyTrendsTopUp(INITIAL_SAMPLER_STATE, {
        now: NOW,
        reason,
      });
      expect(pairing.lastTrends).toEqual({
        at: NOW,
        outcome: "pairing",
        detail: reason,
      });
      expect(pairing.trendsBackoffUntil).toBe(NOW + PAIRING_BACKOFF_MS);
    }
  });
});
