import { describe, it, expect } from "vitest";
import {
  type OverviewResponse,
  STALE_HINT_SECONDS,
  accountFlags,
  accountsFromOverview,
  primaryQuota,
} from "./accounts";

const NOW = 1_800_000_000; // seconds

type Accounts = NonNullable<
  NonNullable<NonNullable<OverviewResponse["latest"]>["snapshot"]>["quota"]
>["accounts"];

const envelope = (
  accounts: Accounts,
  receivedAt: number | string | null = new Date(NOW * 1000).toISOString(),
): OverviewResponse => ({
  latest: {
    id: 42,
    machine: "mini",
    generatedAt: new Date(NOW * 1000).toISOString(),
    receivedAt,
    snapshot: { quota: { accounts } },
  },
});

const raw = (extra: Record<string, unknown> = {}) => ({
  five_hour_pct: 8,
  seven_day_pct: 88,
  five_hour_resets_at: NOW + 3600,
  seven_day_resets_at: NOW + 86400,
  auth_ok: true,
  enabled: true,
  plan: "max20x",
  updated_at: NOW * 1000,
  ...extra,
});

describe("accountsFromOverview", () => {
  it("maps accounts, iu first, hides disabled ones", () => {
    const out = accountsFromOverview(
      envelope({
        me: raw({ five_hour_pct: 3, seven_day_pct: 12 }),
        iu: raw(),
        old: raw({ enabled: false }),
      }),
      NOW,
    );
    expect(out?.map((a) => a.id)).toEqual(["iu", "me"]);
    expect(out?.[0].updatedAt).toBe(NOW);
  });

  it("freshness is min(updated_at, receivedAt)", () => {
    const out = accountsFromOverview(
      envelope({ iu: raw() }, new Date((NOW - 1200) * 1000).toISOString()),
      NOW,
    );
    expect(out?.[0].updatedAt).toBe(NOW - 1200);
  });

  it("returns null without quota or enabled accounts", () => {
    expect(accountsFromOverview(null)).toBeNull();
    expect(accountsFromOverview({ latest: null })).toBeNull();
    expect(accountsFromOverview({ latest: {} })).toBeNull();
    expect(accountsFromOverview({ latest: { snapshot: {} } })).toBeNull();
    expect(
      accountsFromOverview(envelope({ iu: raw({ enabled: false }) })),
    ).toBeNull();
  });

  it("keeps nulls and drops a past exhausted_until", () => {
    const out = accountsFromOverview(
      envelope({
        iu: raw({ five_hour_pct: null, exhausted_until: NOW - 10 }),
      }),
      NOW,
    );
    expect(out?.[0].fiveHourPct).toBeNull();
    expect(out?.[0].exhaustedUntil).toBeNull();
  });
});

describe("freshness fold", () => {
  const fresh = (updated: number | null, received: number | null) =>
    accountsFromOverview(
      envelope(
        { iu: raw({ updated_at: updated }) },
        received === null ? null : new Date(received).toISOString(),
      ),
      NOW,
    )![0].updatedAt;

  it("uses receivedAt when updated_at is null", () => {
    expect(fresh(null, (NOW - 100) * 1000)).toBe(NOW - 100);
  });
  it("is 0 when both are null", () => {
    expect(fresh(null, null)).toBe(0);
  });
  it("uses updated_at when receivedAt is missing", () => {
    expect(fresh((NOW - 50) * 1000, null)).toBe(NOW - 50);
  });
});

describe("title and flags", () => {
  const accounts = accountsFromOverview(
    envelope({
      iu: raw(),
      me: raw({ five_hour_pct: 3, seven_day_pct: 12 }),
    }),
    NOW,
  )!;

  it("flags auth failure, exhaustion and staleness per account", () => {
    const marked = [
      { ...accounts[0], authOk: false },
      {
        ...accounts[1],
        exhaustedUntil: NOW + 600,
        updatedAt: NOW - STALE_HINT_SECONDS - 1,
      },
    ];
    expect(accountFlags(marked[1], STALE_HINT_SECONDS, NOW)).toEqual([
      "exhausted",
      "stale",
    ]);
  });

  it("primaryQuota lends limits and extra_usage from the local file", () => {
    const q = primaryQuota(accounts, {
      five_hour: { utilization: 1, resets_at_epoch: 1 },
      seven_day: { utilization: 2, resets_at_epoch: 2 },
      limits: [],
      extra_usage: null,
      fetched_at: 5,
    });
    expect(q.limits).toEqual([]);
    expect(q.extra_usage).toBeNull();
    expect(q.five_hour.utilization).toBe(8);
  });

  it("primaryQuota exposes the first account and the newest freshness", () => {
    const q = primaryQuota([
      accounts[0],
      { ...accounts[1], updatedAt: NOW - 500 },
    ]);
    expect(q.five_hour.utilization).toBe(8);
    expect(q.fetched_at).toBe(accounts[0].updatedAt);
    expect(
      primaryQuota([
        { ...accounts[0], updatedAt: NOW - 3000 },
        { ...accounts[1], updatedAt: NOW - 500 },
      ]).fetched_at,
    ).toBe(NOW - 500);
  });
});
