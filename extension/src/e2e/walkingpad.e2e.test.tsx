import { describe, it, expect, vi } from "vitest";
import React from "react";
import { Detail } from "@raycast/api";
import { renderCommand, waitFor, assertNoBadSubstrings } from "./render";
import { fixture } from "../walkingpad/fixtures";
import { parseStatus } from "../walkingpad/parse";
import { PadClient } from "../walkingpad/client";

const status = parseStatus(fixture("status-active"));
if (!status) throw new Error("fixture does not parse");

const client: PadClient = {
  status: async () => status,
  start: vi.fn(),
  stop: vi.fn(),
  setSpeed: vi.fn(),
};

vi.mock("../walkingpad/run", () => ({
  connect: () => Promise.resolve({ client, startSpeed: 3 }),
  readCached: () => Promise.resolve(null),
  writeCached: () => Promise.resolve(),
}));

import WalkingPad from "../walkingpad";

describe("walkingpad command", () => {
  it("renders the live status from the fixture", async () => {
    const renderer = await renderCommand(<WalkingPad />);
    await waitFor(() =>
      String(renderer.root.findByType(Detail).props.markdown).includes(
        "Walking",
      ),
    );
    const markdown = String(renderer.root.findByType(Detail).props.markdown);
    expect(markdown).toContain("# Walking · 4.5 km/h");
    expect(markdown).toContain("| Today |");
    assertNoBadSubstrings(markdown, "walkingpad");
    expect(client.setSpeed).not.toHaveBeenCalled();
  });
});
