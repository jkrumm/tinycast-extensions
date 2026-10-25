import { describe, expect, it } from "vitest";
import {
  divergences,
  parseArgoPicks,
  eligibility,
  mergeAccounts,
  parseLocalUsage,
  parsePickOutput,
  pickText,
} from "./routing";
import { AccountQuota } from "./types";

const NOW = 1_792_880_000;

const acct = (over: Partial<AccountQuota> = {}): AccountQuota => ({
  id: "iu",
  plan: "max20x",
  fiveHourPct: 10,
  sevenDayPct: 50,
  fiveHourResetsAt: NOW + 3600,
  sevenDayResetsAt: NOW + 86400,
  authOk: true,
  exhaustedUntil: null,
  updatedAt: NOW - 60,
  ...over,
});

describe("eligibility", () => {
  it("passes a healthy fresh account", () => {
    expect(eligibility(acct(), NOW)).toEqual({ eligible: true, reason: null });
  });

  it("rules out a dead login first", () => {
    expect(
      eligibility(acct({ authOk: false, fiveHourPct: 99 }), NOW).reason,
    ).toBe("login expired");
  });

  it("rules out an exhausted account until its reset passes", () => {
    expect(eligibility(acct({ exhaustedUntil: NOW + 1 }), NOW).reason).toBe(
      "exhausted",
    );
    expect(eligibility(acct({ exhaustedUntil: NOW }), NOW).eligible).toBe(true);
  });

  it("needs a sample", () => {
    expect(
      eligibility(acct({ fiveHourPct: null, sevenDayPct: null }), NOW).reason,
    ).toBe("no sample");
  });

  it("sample age: 6 h is out, just under is in", () => {
    expect(eligibility(acct({ updatedAt: NOW - 6 * 3600 }), NOW).reason).toBe(
      "sample 6h old",
    );
    expect(
      eligibility(acct({ updatedAt: NOW - 6 * 3600 + 1 }), NOW).eligible,
    ).toBe(true);
  });

  it("5h boundary: 85 is out, 84.9 is in", () => {
    expect(eligibility(acct({ fiveHourPct: 85 }), NOW).reason).toBe(
      "5h 85% ≥ 85%",
    );
    expect(eligibility(acct({ fiveHourPct: 84.9 }), NOW).eligible).toBe(true);
  });

  it("weekly boundary: 90 is out, 89 is in", () => {
    expect(eligibility(acct({ sevenDayPct: 90 }), NOW).reason).toBe(
      "7d 90% ≥ 90%",
    );
    expect(eligibility(acct({ sevenDayPct: 89 }), NOW).eligible).toBe(true);
  });
});

describe("parsePickOutput", () => {
  it("reads the --why line after the shell line", () => {
    expect(
      parsePickOutput(
        "wave",
        "unset CLAUDE_CONFIG_DIR\n# picked=iu reason=spill stale=false\n",
      ),
    ).toEqual({ lane: "wave", picked: "iu", reason: "spill" });
  });
  it("is null without it", () => {
    expect(parsePickOutput("wave", "spill\n")).toBeNull();
  });
  it("spill is spelled out, a pick shows its reason", () => {
    expect(
      pickText({ lane: "w", picked: "spill", reason: "no-eligible-account" }),
    ).toBe("spill");
    expect(pickText({ lane: "w", picked: "me", reason: "home" })).toBe(
      "me (home)",
    );
  });
});

describe("parseLocalUsage", () => {
  const json = JSON.stringify({
    accounts: [
      {
        id: "iu",
        plan: "max20x",
        enabled: true,
        five_hour: 2,
        seven_day: 89,
        five_hour_resets_at: NOW + 100,
        seven_day_resets_at: NOW + 200,
        age_s: 50,
        auth_ok: true,
        exhausted_until: null,
      },
      {
        id: "me",
        plan: "max5x",
        enabled: true,
        five_hour: null,
        seven_day: null,
        age_s: null,
        auth_ok: false,
        exhausted_until: null,
      },
      { id: "off", enabled: false },
    ],
  });

  it("maps enabled accounts; no sample is infinitely old", () => {
    const [iu, me, ...rest] = parseLocalUsage(json, NOW)!;
    expect(rest).toEqual([]);
    expect(iu).toMatchObject({
      id: "iu",
      sevenDayPct: 89,
      updatedAt: NOW - 50,
    });
    expect(me).toMatchObject({
      id: "me",
      authOk: false,
      updatedAt: 0,
      fiveHourPct: null,
    });
  });
  it("is null on garbage", () => {
    expect(parseLocalUsage("nope", NOW)).toBeNull();
    expect(parseLocalUsage("{}", NOW)).toBeNull();
  });
});

describe("mergeAccounts", () => {
  const argoMe = acct({ id: "me", sevenDayPct: 8 });
  const localMe = acct({
    id: "me",
    fiveHourPct: null,
    sevenDayPct: null,
    authOk: false,
    updatedAt: 0,
  });

  it("takes numbers from the side that has them, auth from this Mac", () => {
    const [, me] = mergeAccounts([acct(), argoMe], [acct(), localMe]);
    expect(me.sevenDayPct).toBe(8);
    expect(me.authOk).toBe(false);
  });

  it("takes the fresher numbers when both have them", () => {
    const [iu] = mergeAccounts(
      [acct({ sevenDayPct: 88, updatedAt: NOW - 600 })],
      [acct({ sevenDayPct: 89, updatedAt: NOW - 10 })],
    );
    expect(iu.sevenDayPct).toBe(89);
  });

  it("works with one side missing and puts iu first", () => {
    expect(mergeAccounts(null, [argoMe, acct()]).map((a) => a.id)).toEqual([
      "iu",
      "me",
    ]);
    expect(mergeAccounts([acct()], null)).toHaveLength(1);
  });
});

describe("divergences", () => {
  it("flags an account usable on the mini but not here", () => {
    const lines = divergences(
      {
        argo: [acct({ id: "me" })],
        local: [acct({ id: "me", authOk: false })],
      },
      NOW,
    );
    expect(lines).toEqual([
      "me: eligible on the mini, not on this Mac (login expired)",
    ]);
  });
  it("flags the opposite direction", () => {
    expect(
      divergences(
        { argo: [acct({ sevenDayPct: 95 })], local: [acct()] },
        NOW,
      )[0],
    ).toContain("eligible on this Mac, not on the mini (7d 95%");
  });
  it("is quiet when they agree or a side is missing", () => {
    expect(divergences({ argo: [acct()], local: [acct()] }, NOW)).toEqual([]);
    expect(divergences({ argo: null, local: [acct()] }, NOW)).toEqual([]);
  });
});

describe("mini picks", () => {
  const mac = (picked: string, reason = "home") => ({
    lane: "wave",
    picked,
    reason,
  });

  it("parses Argo's lane map in LANES order and drops junk", () => {
    expect(
      parseArgoPicks({
        wave: { picked: "me", reason: "home", stale: true },
        interactive: { picked: "iu", reason: "pace", stale: false },
        bogus: { picked: "x", reason: "home" },
        fan: { picked: 3 },
      }),
    ).toEqual([
      { lane: "interactive", picked: "iu", reason: "pace", stale: false },
      { lane: "wave", picked: "me", reason: "home", stale: true },
    ]);
    expect(parseArgoPicks(undefined)).toBeNull();
    expect(parseArgoPicks({})).toBeNull();
  });

  it("flags a divergence when the picks differ, even if eligibility agrees", () => {
    const view = {
      local: [acct()],
      argo: [acct()],
      picks: [mac("me")],
      argoPicks: [mac("iu")],
    };
    expect(divergences(view, NOW, () => "Waves")).toEqual([
      "Waves: this Mac → me, mini → iu",
    ]);
  });

  it("merges lanes that split the same way into one line", () => {
    const lane = (l: string, p: string) => ({
      lane: l,
      picked: p,
      reason: "home",
    });
    const view = {
      local: null,
      argo: null,
      picks: [lane("wave", "me"), lane("fan", "me"), lane("headless", "iu")],
      argoPicks: [
        lane("wave", "iu"),
        lane("fan", "iu"),
        lane("headless", "iu"),
      ],
    };
    expect(divergences(view, NOW)).toEqual([
      "wave, fan: this Mac → me, mini → iu",
    ]);
  });

  it("does not flag the same account for a different reason", () => {
    const view = {
      local: null,
      argo: null,
      picks: [mac("me", "pace")],
      argoPicks: [mac("me", "home")],
    };
    expect(divergences(view, NOW)).toEqual([]);
  });

  it("falls back to eligibility when the mini sent no picks", () => {
    const view = {
      local: [acct({ authOk: false })],
      argo: [acct()],
      picks: [mac("me")],
      argoPicks: null,
    };
    expect(divergences(view, NOW)[0]).toMatch(/eligible on the mini/);
  });
});
