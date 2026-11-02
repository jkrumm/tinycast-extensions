import { describe, expect, it } from "vitest";
import { parseCache, parseDoctor, parseScenes, serializeCache } from "./parse";

const scenes = JSON.stringify([
  { name: "Chill", id: "9695FBEB", rooms: ["Wohnzimmer"], action_count: 29 },
  { name: "Aus", id: "A1", rooms: [], action_count: 3 },
  { name: "broken" },
]);

const doctor = JSON.stringify({
  total: 28,
  unreachable: [
    {
      name: "Bildschirm",
      room: "Wohnzimmer",
      manufacturer: "Meross",
      via: null,
    },
  ],
  low_battery: [{ name: "Treppe", room: "Schlafzimmer", battery: 1 }],
  dropoffs_24h: [],
});

describe("parseScenes", () => {
  it("maps the CLI shape and drops entries without id or name", () => {
    expect(parseScenes(scenes)).toEqual([
      { id: "9695FBEB", name: "Chill", rooms: ["Wohnzimmer"], actionCount: 29 },
      { id: "A1", name: "Aus", rooms: [], actionCount: 3 },
    ]);
  });

  it("returns null for non-JSON or a non-array", () => {
    expect(parseScenes("home: HomeClaw unreachable")).toBeNull();
    expect(parseScenes("{}")).toBeNull();
  });
});

describe("parseDoctor", () => {
  it("maps unreachable accessories and low batteries", () => {
    expect(parseDoctor(doctor)).toEqual({
      total: 28,
      unreachable: [
        { name: "Bildschirm", room: "Wohnzimmer", manufacturer: "Meross" },
      ],
      lowBattery: [{ name: "Treppe", room: "Schlafzimmer", battery: 1 }],
    });
  });

  it("tolerates missing lists and null rooms", () => {
    expect(parseDoctor('{"total":2}')).toEqual({
      total: 2,
      unreachable: [],
      lowBattery: [],
    });
    expect(parseDoctor("nope")).toBeNull();
  });
});

describe("cache", () => {
  it("round-trips", () => {
    const cache = {
      scenes: parseScenes(scenes)!,
      doctor: parseDoctor(doctor),
      fetchedAt: 5,
    };
    expect(parseCache(serializeCache(cache))).toEqual(cache);
  });

  it("rejects garbage", () => {
    expect(parseCache("x")).toBeNull();
    expect(parseCache('{"scenes":[]}')).toBeNull();
  });
});
