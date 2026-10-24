import { describe, expect, it } from "vitest";
import {
  STALE_ACCOUNT_SECONDS,
  laneGroups,
  menuBarTitle,
  paceWords,
  planWeight,
  summarize,
  summaryTileStatus,
} from "./summary";
import { LanePick } from "./routing";
import { WEEK_SECONDS } from "./limits";
import { AccountQuota } from "./types";

const NOW = 1_800_000_000;
// Four days into the week.
const RESET = NOW + 3 * 86_400;

const account = (over: Partial<AccountQuota>): AccountQuota => ({
  id: "iu",
  plan: "max20x",
  fiveHourPct: 5,
  sevenDayPct: 10,
  fiveHourResetsAt: NOW + 3600,
  sevenDayResetsAt: RESET,
  authOk: true,
  exhaustedUntil: null,
  updatedAt: NOW,
  ...over,
});
const iu = (over: Partial<AccountQuota> = {}) => account(over);
const me = (over: Partial<AccountQuota> = {}) =>
  account({ id: "me", plan: "max5x", ...over });
const pick = (lane: string, picked: string, reason: string): LanePick => ({
  lane,
  picked,
  reason,
});
const routing = (picks: LanePick[]) => ({ local: null, argo: null, picks });

describe("planWeight", () => {
  it("reads the plan multiple", () => {
    expect(planWeight("max20x")).toBe(20);
    expect(planWeight("max5x")).toBe(5);
    expect(planWeight("pro")).toBeNull();
    expect(planWeight(null)).toBeNull();
  });
});

describe("pool", () => {
  it("weighs a 5x plan a quarter of a 20x plan", () => {
    const s = summarize(
      [iu({ sevenDayPct: 89 }), me({ sevenDayPct: 9 })],
      undefined,
      NOW,
    );
    expect(s.pool?.usedPct).toBeCloseTo(73, 5);
    expect(s.pool?.total).toBe(25);
    expect(s.pool?.left).toBeCloseTo(6.75, 5);
    expect(s.pool?.weighted).toBe(true);
  });

  it("counts accounts equally when a plan multiple is unknown", () => {
    const s = summarize(
      [iu({ plan: null, sevenDayPct: 80 }), me({ sevenDayPct: 20 })],
      undefined,
      NOW,
    );
    expect(s.pool?.usedPct).toBe(50);
    expect(s.pool?.weighted).toBe(false);
  });

  it("is null without any weekly number", () => {
    const s = summarize([iu({ sevenDayPct: null })], undefined, NOW);
    expect(s.pool).toBeNull();
  });
});

describe("working account and severity", () => {
  it("follows this Mac's interactive pick", () => {
    const s = summarize(
      [iu({ sevenDayPct: 89 }), me({ sevenDayPct: 9 })],
      routing([pick("interactive", "me", "pace")]),
      NOW,
    );
    expect(s.working).toBe("me");
    expect(s.severity).toBe("ok");
    expect(s.hasPicks).toBe(true);
    expect(menuBarTitle(s)).toBe("me 9%");
    expect(summaryTileStatus(s)).toBe("me · pool 73%");
  });

  it("estimates from the most capacity left when the picker did not answer", () => {
    const s = summarize(
      [iu({ sevenDayPct: 50 }), me({ sevenDayPct: 5 })],
      undefined,
      NOW,
    );
    expect(s.working).toBe("iu"); // 20·50 = 1000 vs 5·95 = 475
    expect(s.hasPicks).toBe(false);
  });

  it("marks a spill", () => {
    const s = summarize(
      [iu({ sevenDayPct: 95 }), me({ sevenDayPct: 95 })],
      routing([pick("interactive", "iu", "spill")]),
      NOW,
    );
    expect(s.severity).toBe("spill");
    expect(menuBarTitle(s)).toBe("⊘ spill");
    expect(s.headline).toContain("No account has room");
  });

  it("marks a broken account and says which", () => {
    const s = summarize(
      [iu(), me({ authOk: false })],
      routing([pick("interactive", "iu", "home")]),
      NOW,
    );
    expect(s.severity).toBe("broken");
    expect(menuBarTitle(s)).toBe("⚠ iu 10%");
    expect(s.headline).toContain("me: login expired");
  });

  it("flags a stale sample", () => {
    const s = summarize(
      [iu(), me({ updatedAt: NOW - STALE_ACCOUNT_SECONDS - 1 })],
      routing([pick("interactive", "iu", "home")]),
      NOW,
    );
    expect(s.severity).toBe("broken");
    expect(s.headline).toContain("stale sample");
  });

  it("flags low pool headroom", () => {
    const s = summarize(
      [iu({ sevenDayPct: 86 }), me({ sevenDayPct: 88 })],
      routing([pick("interactive", "iu", "home")]),
      NOW,
    );
    expect(s.severity).toBe("low");
    expect(menuBarTitle(s)).toBe("▾ iu 86%");
  });
});

describe("paceWords", () => {
  const week = (percent: number) =>
    summarize([iu({ sevenDayPct: percent })], undefined, NOW).accounts[0].pace;
  const fmt = () => "Fri 14:00";

  it("projects the week's end", () => {
    // 4/7 of the week gone at 40 % → ~70 % at reset.
    expect(paceWords(week(40), fmt)).toBe("~70% at reset");
  });

  it("names the run-out when ahead of pace", () => {
    expect(paceWords(week(80), fmt)).toBe("out Fri 14:00");
  });

  it("is honest when it is too early", () => {
    const early = summarize(
      [iu({ sevenDayResetsAt: NOW + WEEK_SECONDS - 60 })],
      undefined,
      NOW,
    ).accounts[0].pace;
    expect(paceWords(early, fmt)).toBe("too early to project");
  });
});

describe("laneGroups", () => {
  it("collapses lanes sharing account and reason, in lane order", () => {
    const groups = laneGroups([
      pick("headless", "me", "home"),
      pick("interactive", "me", "pace"),
      pick("wave", "me", "home"),
      pick("fan", "iu", "spill"),
    ]);
    expect(groups).toEqual([
      { account: "me", reason: "pace", lanes: ["interactive"] },
      { account: "me", reason: "home", lanes: ["wave", "headless"] },
      { account: null, reason: "spill", lanes: ["fan"] },
    ]);
  });
});
