import { describe, expect, it } from "vitest";
import {
  attentionRows,
  climateLines,
  climateSummary,
  friendlyError,
  humidityHint,
  menuBarTitle,
  mergeStatus,
  namiTitle,
  namiToggleTarget,
  namiToggleTitle,
  sceneSubtitle,
  someoneHomeTitle,
  tileStatus,
} from "./format";
import { Climate, Doctor, HomeStatus } from "./types";

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

const climate: Climate = {
  sensor: "Eve Room CF8D",
  reachable: true,
  temperatureC: 21.94,
  humidityPct: 42.4,
  batteryPct: 100,
};
const status: HomeStatus = { climate, namiHome: true, someoneHome: true };

describe("status text", () => {
  it("builds the compact title", () => {
    expect(menuBarTitle(status)).toBe("21.9° 42%");
    expect(menuBarTitle({ ...status, climate: null })).toBe("--");
    expect(
      menuBarTitle({ ...status, climate: { ...climate, humidityPct: null } }),
    ).toBe("21.9°");
    expect(menuBarTitle(null)).toBe("--");
    expect(climateSummary(climate)).toBe("21.9° · 42%");
  });

  it("hints at humidity extremes only", () => {
    expect(humidityHint(60)).toBe("ventilate");
    expect(humidityHint(35)).toBe("dry air");
    expect(humidityHint(36)).toBeNull();
    expect(humidityHint(null)).toBeNull();
  });

  it("lists the known climate lines with the hint", () => {
    expect(climateLines(climate).map((l) => l.title)).toEqual([
      "Temperature: 21.9 °C",
      "Humidity: 42 %",
      "Eve Room battery: 100 %",
    ]);
    const damp = climateLines({
      ...climate,
      humidityPct: 64,
      batteryPct: null,
    });
    expect(damp.map((l) => l.title)).toEqual([
      "Temperature: 21.9 °C",
      "Humidity: 64 % — ventilate",
    ]);
    expect(climateLines(null)).toEqual([]);
  });

  it("words Nami and presence, and toggles to the opposite", () => {
    expect(namiTitle(true)).toBe("Nami is home");
    expect(namiTitle(false)).toBe("Nami is with you");
    expect(namiTitle(null)).toBe("Nami: unknown");
    expect(namiToggleTarget(true)).toBe(false);
    expect(namiToggleTarget(false)).toBe(true);
    expect(namiToggleTarget(null)).toBeNull();
    expect(namiToggleTitle(true)).toBe("Nami Comes Along");
    expect(namiToggleTitle(false)).toBe("Nami Stays Home");
    expect(someoneHomeTitle(false)).toBe("Someone home: no");
    expect(someoneHomeTitle(null)).toBe("Someone home: unknown");
  });

  it("keeps last-known values for holes in a fresh reading", () => {
    const hole: HomeStatus = {
      climate: {
        sensor: "Eve Room CF8D",
        reachable: false,
        temperatureC: null,
        humidityPct: null,
        batteryPct: null,
      },
      namiHome: null,
      someoneHome: false,
    };
    const merged = mergeStatus(hole, status);
    expect(merged.climate).toMatchObject({
      reachable: false,
      temperatureC: 21.94,
      humidityPct: 42.4,
    });
    expect(merged.namiHome).toBe(true);
    expect(merged.someoneHome).toBe(false);
    expect(mergeStatus(hole, null)).toBe(hole);
  });

  it("shows climate and Nami on the tile unless something needs attention", () => {
    expect(tileStatus([], null, status)).toBe("21.9° · Nami home");
    expect(tileStatus([], null, { ...status, namiHome: false })).toBe(
      "21.9° · Nami out",
    );
    expect(tileStatus([], doctor, status)).toBe("3 need attention");
  });
});
