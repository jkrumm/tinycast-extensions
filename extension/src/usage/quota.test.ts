import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileMock = vi.fn();
const execFileMock = vi.fn(
  (_file: string, _args: string[], callback: (err: Error | null) => void) => {
    callback(null);
  },
);

vi.mock("fs/promises", () => ({
  readFile: (...args: unknown[]) =>
    (readFileMock as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) =>
    (execFileMock as (...a: unknown[]) => unknown)(...args),
}));

const argoFetchMock = vi.fn();
vi.mock("../lib/argo", () => ({
  argoFetch: (...args: unknown[]) =>
    (argoFetchMock as (...a: unknown[]) => unknown)(...args),
}));

const loadLocalRoutingMock = vi.fn();
vi.mock("./local", () => ({
  loadLocalRouting: (...args: unknown[]) =>
    (loadLocalRoutingMock as (...a: unknown[]) => unknown)(...args),
}));

import { getQuota, isStaleHint } from "./quota";

function okQuota(fetchedAt: number) {
  return {
    five_hour: { utilization: 12, resets_at_epoch: 123 },
    seven_day: { utilization: 38, resets_at_epoch: 456 },
    seven_day_sonnet: { utilization: 5, resets_at_epoch: 789 },
    fetched_at: fetchedAt,
  };
}

describe("isStaleHint", () => {
  it("is false for a fresh timestamp", () => {
    expect(isStaleHint(Date.now() / 1000)).toBe(false);
  });

  it("is true after 15 minutes", () => {
    expect(isStaleHint(Date.now() / 1000 - 16 * 60)).toBe(true);
  });
});

describe("getQuota", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    argoFetchMock.mockReset();
    argoFetchMock.mockRejectedValue(new Error("argo down"));
    loadLocalRoutingMock.mockReset();
    loadLocalRoutingMock.mockResolvedValue(null);
    execFileMock.mockClear();
    execFileMock.mockImplementation((_file, _args, cb) => cb(null));
  });

  it("returns fresh data without re-fetching", async () => {
    const fresh = okQuota(Date.now() / 1000);
    readFileMock.mockResolvedValue(JSON.stringify(fresh));

    const quota = await getQuota();
    expect(quota).toMatchObject(fresh);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("triggers a re-fetch when the file is missing, then re-reads", async () => {
    let call = 0;
    readFileMock.mockImplementation(() => {
      call += 1;
      if (call === 1) throw new Error("ENOENT");
      return JSON.stringify(okQuota(Date.now() / 1000));
    });

    const quota = await getQuota();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect("error" in quota).toBe(false);
  });

  it("triggers a re-fetch when stale (fetched_at > 300s ago)", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify(okQuota(Date.now() / 1000 - 600)),
    );

    await getQuota();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns an error shape when still missing after the re-fetch attempt", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));

    const quota = await getQuota();
    expect("error" in quota).toBe(true);
    expect(quota.fetched_at).toBe(0);
  });

  it("ignores a failing fetch script and falls back to disk", async () => {
    execFileMock.mockImplementation((_file, _args, cb) =>
      cb(new Error("boom")),
    );
    readFileMock.mockRejectedValue(new Error("ENOENT"));

    const quota = await getQuota();
    expect("error" in quota).toBe(true);
  });
});

describe("getQuota via argo", () => {
  const nowMs = () => Date.now();
  const overview = (accounts: Record<string, unknown>, picks?: unknown) => ({
    latest: {
      id: 1,
      machine: "mini",
      generatedAt: new Date(nowMs()).toISOString(),
      receivedAt: new Date(nowMs()).toISOString(),
      snapshot: { quota: { accounts, ...(picks ? { picks } : {}) } },
    },
  });
  const acct = (extra: Record<string, unknown> = {}) => ({
    five_hour_pct: 8,
    seven_day_pct: 88,
    five_hour_resets_at: Date.now() / 1000 + 3600,
    seven_day_resets_at: Date.now() / 1000 + 86400,
    auth_ok: true,
    enabled: true,
    plan: "max20x",
    updated_at: nowMs(),
    ...extra,
  });

  beforeEach(() => {
    argoFetchMock.mockReset();
    readFileMock.mockReset();
    loadLocalRoutingMock.mockReset();
    loadLocalRoutingMock.mockResolvedValue(null);
    execFileMock.mockClear();
  });

  it("uses argo accounts and skips the local fetch", async () => {
    argoFetchMock.mockResolvedValue(
      overview({ me: acct({ five_hour_pct: 3 }), iu: acct() }),
    );
    const q = await getQuota();
    expect("error" in q).toBe(false);
    if ("error" in q) return;
    expect(q.accounts?.map((a) => a.id)).toEqual(["iu", "me"]);
    expect(q.five_hour.utilization).toBe(8);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("treats a 2 h old argo payload as failed and falls back", async () => {
    const old = Date.now() - 2 * 3600_000;
    argoFetchMock.mockResolvedValue({
      latest: {
        receivedAt: new Date(old).toISOString(),
        snapshot: { quota: { accounts: { iu: acct({ updated_at: old }) } } },
      },
    });
    readFileMock.mockResolvedValue(JSON.stringify(okQuota(Date.now() / 1000)));
    const q = await getQuota();
    if ("error" in q) throw new Error("unexpected error");
    expect(q.accounts?.[0].id).toBe("iu (local)");
  });

  it("merges limits and extra_usage from the local file without fetching", async () => {
    argoFetchMock.mockResolvedValue(overview({ iu: acct(), me: acct() }));
    readFileMock.mockResolvedValue(
      JSON.stringify({
        ...okQuota(Date.now() / 1000),
        limits: [{ kind: "weekly_scoped", label: "Fable" }],
        extra_usage: { is_enabled: true },
      }),
    );
    const q = await getQuota();
    if ("error" in q) throw new Error("unexpected error");
    expect(q.limits).toHaveLength(1);
    expect(q.extra_usage).toEqual({ is_enabled: true });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("falls back to the local file labelled iu (local) when argo fails", async () => {
    argoFetchMock.mockRejectedValue(new Error("502"));
    readFileMock.mockResolvedValue(JSON.stringify(okQuota(Date.now() / 1000)));
    const q = await getQuota();
    if ("error" in q) throw new Error("unexpected error");
    expect(q.accounts?.map((a) => a.id)).toEqual(["iu (local)"]);
  });

  it("falls back when the payload has no quota yet", async () => {
    argoFetchMock.mockResolvedValue({ latest: { snapshot: {} } });
    readFileMock.mockResolvedValue(JSON.stringify(okQuota(Date.now() / 1000)));
    const q = await getQuota();
    if ("error" in q) throw new Error("unexpected error");
    expect(q.accounts?.[0].id).toBe("iu (local)");
  });

  it("returns the error shape when neither source has data", async () => {
    argoFetchMock.mockResolvedValue({ latest: null });
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const q = await getQuota();
    expect("error" in q).toBe(true);
  });

  it("merges this Mac's picker view with argo's and exposes both", async () => {
    argoFetchMock.mockResolvedValue(
      overview({ iu: acct(), me: acct({ seven_day_pct: 8 }) }),
    );
    const nowS = Date.now() / 1000;
    const base = {
      plan: null,
      fiveHourResetsAt: null,
      sevenDayResetsAt: null,
      exhaustedUntil: null,
      updatedAt: nowS,
    };
    loadLocalRoutingMock.mockResolvedValue({
      accounts: [
        { ...base, id: "iu", fiveHourPct: 2, sevenDayPct: 89, authOk: true },
        {
          ...base,
          id: "me",
          fiveHourPct: null,
          sevenDayPct: null,
          authOk: false,
        },
      ],
      picks: [{ lane: "wave", picked: "iu", reason: "spill" }],
    });
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const q = await getQuota();
    if ("error" in q) throw new Error("unexpected error");
    const me = q.accounts?.find((a) => a.id === "me");
    expect(me?.sevenDayPct).toBe(8); // argo's numbers
    expect(me?.authOk).toBe(false); // this Mac's auth
    expect(q.routing?.picks).toHaveLength(1);
    expect(q.routing?.argo).toHaveLength(2);
  });

  it("carries the mini's picks, and null when the field is absent", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    argoFetchMock.mockResolvedValue(
      overview(
        { iu: acct() },
        { wave: { picked: "iu", reason: "home", stale: false } },
      ),
    );
    const q = await getQuota();
    if ("error" in q) throw new Error("unexpected error");
    expect(q.routing?.argoPicks).toEqual([
      { lane: "wave", picked: "iu", reason: "home", stale: false },
    ]);

    argoFetchMock.mockResolvedValue(overview({ iu: acct() }));
    const old = await getQuota();
    if ("error" in old) throw new Error("unexpected error");
    expect(old.routing?.argoPicks).toBeNull();
  });

  it("works from the local picker alone when argo is down", async () => {
    argoFetchMock.mockRejectedValue(new Error("502"));
    const nowS = Date.now() / 1000;
    loadLocalRoutingMock.mockResolvedValue({
      accounts: [
        {
          id: "iu",
          plan: null,
          fiveHourPct: 2,
          sevenDayPct: 89,
          fiveHourResetsAt: null,
          sevenDayResetsAt: null,
          authOk: true,
          exhaustedUntil: null,
          updatedAt: nowS,
        },
      ],
      picks: null,
    });
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const q = await getQuota();
    if ("error" in q) throw new Error("unexpected error");
    expect(q.accounts?.map((a) => a.id)).toEqual(["iu"]);
    expect(q.routing?.argo).toBeNull();
  });
});
