import { describe, expect, it } from "vitest";
import {
  attentionRows,
  friendlyError,
  sceneSubtitle,
  tileStatus,
} from "./format";
import { Doctor } from "./types";

const doctor: Doctor = {
  total: 28,
  unreachable: [
    { name: "Bildschirm", room: "Wohnzimmer", manufacturer: "Meross" },
  ],
  lowBattery: [
    { name: "Flur", room: null, battery: 15 },
    { name: "Treppe", room: "Schlafzimmer", battery: 1 },
  ],
};

describe("attentionRows", () => {
  it("lists unreachable first, then batteries lowest first", () => {
    const rows = attentionRows(doctor);
    expect(rows.map((r) => r.title)).toEqual(["Bildschirm", "Treppe", "Flur"]);
    expect(rows[0]).toMatchObject({
      kind: "unreachable",
      subtitle: "Wohnzimmer · Meross",
      copy: "Bildschirm (Wohnzimmer) is unreachable",
    });
    expect(rows[1]).toMatchObject({ kind: "battery", tag: "1%" });
    expect(rows[2].subtitle).toBe("");
  });

  it("is empty without a reading", () => {
    expect(attentionRows(null)).toEqual([]);
  });
});

describe("friendlyError", () => {
  it("explains an unreachable HomeClaw", () => {
    expect(friendlyError("home: HomeClaw unreachable (ssh timed out)")).toMatch(
      /mini online/,
    );
  });
  it("explains a missing binary and a timeout", () => {
    expect(friendlyError("spawn /x/home ENOENT")).toMatch(/missing/);
    expect(friendlyError("timed out")).toMatch(/in time/);
  });
  it("falls back to the first stderr line", () => {
    expect(friendlyError("no such scene\nusage: ...")).toBe("no such scene");
    expect(friendlyError("  ")).toMatch(/without a message/);
  });
});

describe("sceneSubtitle + tileStatus", () => {
  it("joins rooms", () => {
    expect(
      sceneSubtitle({ id: "1", name: "x", rooms: ["A", "B"], actionCount: 1 }),
    ).toBe("A, B");
  });
  it("prefers attention over the scene count", () => {
    const scenes = [{ id: "1", name: "x", rooms: [], actionCount: 1 }];
    expect(tileStatus(null, null)).toBe("No scenes yet");
    expect(tileStatus(scenes, null)).toBe("1 scenes");
    expect(tileStatus(scenes, doctor)).toBe("3 need attention");
  });
});
