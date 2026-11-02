import { describe, expect, it } from "vitest";
import {
  parseCache,
  parseDoctor,
  parseScenes,
  parseStatus,
  parseStatusCache,
  serializeCache,
  serializeStatusCache,
} from "./parse";

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

describe("parseStatus", () => {
  const raw =
    '{"climate":{"sensor":"Eve Room CF8D","reachable":true,"temperature_c":21.9,"humidity_pct":42,"battery_pct":100},"nami_home":true,"someone_home":false}';

  it("maps the CLI shape", () => {
    expect(parseStatus(raw)).toEqual({
      climate: {
        sensor: "Eve Room CF8D",
        reachable: true,
        temperatureC: 21.9,
        humidityPct: 42,
        batteryPct: 100,
      },
      namiHome: true,
      someoneHome: false,
    });
  });

  it("turns missing or null fields into null", () => {
    expect(
      parseStatus('{"climate":null,"nami_home":null,"someone_home":true}'),
    ).toEqual({ climate: null, namiHome: null, someoneHome: true });
    expect(parseStatus('{"climate":{"temperature_c":"x"}}')?.climate).toEqual({
      sensor: null,
      reachable: null,
      temperatureC: null,
      humidityPct: null,
      batteryPct: null,
    });
  });

  it("rejects non-objects and round-trips the cache", () => {
    expect(parseStatus("oops")).toBeNull();
    expect(parseStatus("[]")).toBeNull();
    const cache = { status: parseStatus(raw)!, fetchedAt: 9 };
    expect(parseStatusCache(serializeStatusCache(cache))).toEqual(cache);
    expect(parseStatusCache('{"status":{}}')).toBeNull();
  });
});
