import { describe, it, expect } from "vitest";
import {
  STALE_HINT_SECONDS,
  accountFlags,
  accountsFromOverview,
  accountsTitle,
  primaryQuota,
} from "./accounts";

const NOW = 1_800_000_000; // seconds

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
      {
        latest: {
          quota: {
            accounts: {
              me: raw({ five_hour_pct: 3, seven_day_pct: 12 }),
              iu: raw(),
              old: raw({ enabled: false }),
            },
          },
        },
        receivedAt: NOW * 1000,
      },
      NOW,
    );
    expect(out?.map((a) => a.id)).toEqual(["iu", "me"]);
    expect(out?.[0].updatedAt).toBe(NOW);
  });

  it("freshness is min(updated_at, receivedAt)", () => {
    const out = accountsFromOverview(
      {
        latest: { quota: { accounts: { iu: raw() } } },
        receivedAt: (NOW - 1200) * 1000,
      },
      NOW,
    );
    expect(out?.[0].updatedAt).toBe(NOW - 1200);
  });

  it("returns null without quota or enabled accounts", () => {
    expect(accountsFromOverview(null)).toBeNull();
    expect(accountsFromOverview({ latest: null })).toBeNull();
    expect(accountsFromOverview({ latest: {} })).toBeNull();
    expect(
      accountsFromOverview({
        latest: { quota: { accounts: { iu: raw({ enabled: false }) } } },
      }),
    ).toBeNull();
  });

  it("keeps nulls and drops a past exhausted_until", () => {
    const out = accountsFromOverview(
      {
        latest: {
          quota: {
            accounts: {
              iu: raw({
                five_hour_pct: null,
                exhausted_until: NOW - 10,
              }),
            },
          },
        },
        receivedAt: NOW * 1000,
      },
      NOW,
    );
    expect(out?.[0].fiveHourPct).toBeNull();
    expect(out?.[0].exhaustedUntil).toBeNull();
  });
});

describe("title and flags", () => {
  const accounts = accountsFromOverview(
    {
      latest: {
        quota: {
          accounts: {
            iu: raw(),
            me: raw({ five_hour_pct: 3, seven_day_pct: 12 }),
          },
        },
      },
      receivedAt: NOW * 1000,
    },
    NOW,
  )!;

  it("formats both accounts compactly", () => {
    expect(accountsTitle(accounts, STALE_HINT_SECONDS, NOW)).toBe(
      "iu 8/88 · me 3/12",
    );
  });

  it("marks auth failure, exhaustion and staleness per account", () => {
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
    expect(accountsTitle(marked, STALE_HINT_SECONDS, NOW)).toBe(
      "iu 8/88⚠auth · me 3/12⊘…",
    );
  });

  it("primaryQuota exposes the first account and the oldest freshness", () => {
    const q = primaryQuota([
      accounts[0],
      { ...accounts[1], updatedAt: NOW - 500 },
    ]);
    expect(q.five_hour.utilization).toBe(8);
    expect(q.fetched_at).toBe(NOW - 500);
  });
});
