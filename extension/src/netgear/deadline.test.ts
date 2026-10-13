import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDeadline } from "./deadline";

describe("withDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves with the promise's value when it settles in time", async () => {
    await expect(
      withDeadline(Promise.resolve("done"), 1_000, () => "late"),
    ).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the promise's error when it fails in time", async () => {
    await expect(
      withDeadline(Promise.reject(new Error("boom")), 1_000, () => "late"),
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves with the fallback when the promise never settles", async () => {
    const result = withDeadline(
      new Promise<string>(() => {}),
      1_000,
      () => "late",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("late");
  });

  it("ignores a rejection that arrives after the deadline", async () => {
    let fail: (e: Error) => void = () => {};
    const slow = new Promise<string>((_, reject) => {
      fail = reject;
    });
    const result = withDeadline(slow, 1_000, () => "late");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("late");
    fail(new Error("too late"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
