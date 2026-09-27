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
    execFileMock.mockClear();
    execFileMock.mockImplementation((_file, _args, cb) => cb(null));
  });

  it("returns fresh data without re-fetching", async () => {
    const fresh = okQuota(Date.now() / 1000);
    readFileMock.mockResolvedValue(JSON.stringify(fresh));

    const quota = await getQuota();
    expect(quota).toEqual(fresh);
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
