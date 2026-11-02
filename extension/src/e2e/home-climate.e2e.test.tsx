import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { Action, Detail } from "@raycast/api";
import { renderCommand, waitFor } from "./render";
import { climateFixture } from "../home/fixtures";
import { ClimateData } from "../home/run";
import { ClimateRange } from "../home/climate";

const NOW = Date.now();
const loadMock = vi.fn<(range: ClimateRange) => Promise<ClimateData>>();
vi.mock("../home/run", () => ({
  loadClimate: (range: ClimateRange) => loadMock(range),
}));

import HomeClimate from "../home-climate";

const data = (range: ClimateRange, hours: number): ClimateData => ({
  range,
  status: null,
  points: climateFixture({ end: NOW, hours }),
  at: NOW,
});

const markdown = (renderer: Awaited<ReturnType<typeof renderCommand>>) =>
  renderer.root.findByType(Detail).props.markdown as string;

const pick = async (
  renderer: Awaited<ReturnType<typeof renderCommand>>,
  title: string,
) => {
  const action = renderer.root
    .findAllByType(Action)
    .find((a) => a.props.title === title)!;
  await act(async () => {
    action.props.onAction();
  });
};

describe("home-climate command", () => {
  beforeEach(() => loadMock.mockReset());

  it("labels the charts with the range the data was loaded for", async () => {
    loadMock.mockImplementation(async (r) =>
      r === "24h" ? data("24h", 24) : data("48h", 48),
    );
    const renderer = await renderCommand(<HomeClimate />);
    await waitFor(() => markdown(renderer).includes("last 48 h"));

    let release!: () => void;
    loadMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(data("24h", 24));
        }),
    );
    await pick(renderer, "Last 24 h");
    // loading: the old chart keeps its own (old) label
    expect(markdown(renderer)).toContain("last 48 h");
    expect(markdown(renderer)).not.toContain("last 24 h");
    expect(renderer.root.findByType(Detail).props.isLoading).toBe(true);

    await act(async () => release());
    await waitFor(() => markdown(renderer).includes("last 24 h"));
    expect(markdown(renderer)).not.toContain("last 48 h");
  });

  it("keeps the old range's label and warns when the new range fails", async () => {
    loadMock.mockResolvedValueOnce(data("48h", 48));
    const renderer = await renderCommand(<HomeClimate />);
    await waitFor(() => markdown(renderer).includes("last 48 h"));

    loadMock.mockRejectedValueOnce(new Error("home: HomeClaw unreachable"));
    await pick(renderer, "Last 7 days");
    await waitFor(() => markdown(renderer).includes("⚠️"));
    expect(markdown(renderer)).toContain("last 48 h");
    expect(markdown(renderer)).toContain("showing the last 48 h");
    expect(markdown(renderer)).not.toContain("last 7 days");
  });
});
