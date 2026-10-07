import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { Action, Detail } from "@raycast/api";
import {
  renderCommand,
  waitFor,
  assertNoBadSubstrings,
  imageSvg,
} from "./render";
import { UsageQuota, TimeseriesResponse } from "../usage/types";

const getQuotaMock = vi.fn<() => Promise<UsageQuota>>();
const getTimeseriesMock = vi.fn<() => Promise<TimeseriesResponse>>();

vi.mock("../usage/quota", () => ({
  getQuota: () => getQuotaMock(),
  isStaleHint: () => false,
}));
vi.mock("../usage/spend", async () => {
  const actual =
    await vi.importActual<typeof import("../usage/spend")>("../usage/spend");
  return { ...actual, getTimeseries: () => getTimeseriesMock() };
});

import ClaudeUsage from "../claude-usage";

const okQuota: UsageQuota = {
  five_hour: { utilization: 42, resets_at_epoch: Date.now() / 1000 + 3600 },
  seven_day: { utilization: 68, resets_at_epoch: Date.now() / 1000 + 86400 },
  seven_day_sonnet: {
    utilization: 12,
    resets_at_epoch: Date.now() / 1000 + 86400,
  },
  fetched_at: Date.now() / 1000,
};

const timeseries: TimeseriesResponse = {
  buckets: [
    { bucket: "2026-09-27", groups: { "claude-code": 4.2, codex: 1.1 } },
    { bucket: "2026-09-28", groups: { "claude-code": 3.8, codex: 0.9 } },
    { bucket: "2026-09-29", groups: { "claude-code": 5.1, codex: 1.4 } },
  ],
  groupKeys: ["claude-code", "codex"],
};

describe("claude-usage command", () => {
  beforeEach(() => {
    getQuotaMock.mockReset();
    getTimeseriesMock.mockReset();
  });

  it("renders quota + spend together without crashing", async () => {
    getQuotaMock.mockResolvedValue(okQuota);
    getTimeseriesMock.mockResolvedValue(timeseries);

    const renderer = await renderCommand(<ClaudeUsage />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    expect(markdown).toContain("Claude Usage");
    const totals = imageSvg(markdown, "Spend totals");
    expect(totals).toContain(">TODAY<");
    expect(totals).toContain(">7 DAYS<");
    expect(totals).toContain(">$16.50<"); // 7-day total of the fixture
    assertNoBadSubstrings(
      markdown.replace(/data:[^)]+/g, "data:"),
      "claude-usage ok",
    );
  });

  it("shows the quota error text when the quota fetch fails", async () => {
    getQuotaMock.mockResolvedValue({
      error: "No Claude quota data",
      fetched_at: 0,
    });
    getTimeseriesMock.mockResolvedValue(timeseries);

    const renderer = await renderCommand(<ClaudeUsage />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );
    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    expect(markdown).toContain("No Claude quota data");
    assertNoBadSubstrings(markdown, "claude-usage quota error");
  });

  it("shows the spend-offline banner over cached spend when only spend fails", async () => {
    getQuotaMock.mockResolvedValue(okQuota);
    getTimeseriesMock.mockResolvedValueOnce(timeseries);
    const renderer = await renderCommand(<ClaudeUsage />);
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );

    getTimeseriesMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const refresh = renderer.root
      .findAllByType(Action)
      .find((a) => a.props.title === "Refresh")!;
    await act(async () => {
      refresh.props.onAction();
    });
    await waitFor(
      () => renderer.root.findByType(Detail).props.isLoading === false,
    );

    const markdown = renderer.root.findByType(Detail).props.markdown as string;
    expect(markdown).toContain("Spend server not reachable");
    expect(imageSvg(markdown, "Spend totals")).toContain(">7 DAYS<"); // still showing cached spend
    assertNoBadSubstrings(markdown, "claude-usage spend offline");
  });
});
