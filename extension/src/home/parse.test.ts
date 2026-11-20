import { describe, expect, it } from "vitest";
import {
  parseCache,
  parseDevices,
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

describe("parseCache devices", () => {
  it("reads a cache written before Lights existed as an empty list", () => {
    expect(
      parseCache('{"scenes":[],"doctor":null,"fetchedAt":5}')?.devices,
    ).toEqual([]);
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
      devices: [],
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
    const cache = { status: parseStatus(raw)!, fetchedAt: 9, climateAt: 4 };
    expect(parseStatusCache(serializeStatusCache(cache))).toEqual(cache);
    expect(parseStatusCache('{"status":{}}')).toBeNull();
  });
});

// A trimmed `home device-map --json` with placeholder ids. The sensors,
// bridges, buttons and the Status room must not show up as lamps.
const deviceMap = {
  homes: [
    {
      name: "Zuhause",
      zones: [
        {
          name: "Erdgeschoss",
          rooms: [
            {
              name: "Flur",
              devices: [
                {
                  id: "flur-sensor",
                  name: "Eve Motion Flur",
                  category: "sensor",
                  controllable: ["identify"],
                  state_summary: "clear",
                  reachable: true,
                },
                {
                  id: "flur-lamp",
                  name: "Flur",
                  category: "lightbulb",
                  controllable: [
                    "identify",
                    "power",
                    "color_temperature",
                    "brightness",
                  ],
                  state_summary: "off",
                  reachable: true,
                },
              ],
            },
            {
              name: "Badezimmer",
              devices: [
                {
                  id: "bad-ecke",
                  name: "Bad Ecke",
                  category: "outlet",
                  controllable: ["identify", "power"],
                  state_summary: "off",
                  reachable: true,
                },
                {
                  id: "badschalter",
                  name: "Badschalter",
                  category: "programmable_switch",
                  controllable: ["identify"],
                  state_summary: "unknown",
                  reachable: true,
                },
              ],
            },
            {
              name: "Wohnzimmer",
              devices: [
                {
                  id: "esstisch-1",
                  name: "Esstisch",
                  category: "lightbulb",
                  controllable: [
                    "brightness",
                    "power",
                    "color_temperature",
                    "identify",
                  ],
                  state_summary: "on 70%",
                  reachable: true,
                },
                {
                  id: "esstisch-2",
                  name: "Esstisch",
                  category: "lightbulb",
                  controllable: [
                    "power",
                    "color_temperature",
                    "brightness",
                    "identify",
                  ],
                  state_summary: "on 65%",
                  reachable: true,
                },
                {
                  id: "esstisch-3",
                  name: "Esstisch",
                  category: "lightbulb",
                  controllable: [
                    "identify",
                    "brightness",
                    "color_temperature",
                    "power",
                  ],
                  state_summary: "on 70%",
                  reachable: true,
                },
                {
                  id: "kueche-1",
                  name: "Küche",
                  category: "lightbulb",
                  controllable: [
                    "power",
                    "color_temperature",
                    "brightness",
                    "identify",
                  ],
                  state_summary: "off",
                  reachable: true,
                },
                {
                  id: "kueche-2",
                  name: "Küche",
                  category: "lightbulb",
                  controllable: [
                    "power",
                    "color_temperature",
                    "brightness",
                    "identify",
                  ],
                  state_summary: "off",
                  reachable: true,
                },
                {
                  id: "schreibtisch-1",
                  name: "Schreibtisch",
                  category: "lightbulb",
                  controllable: [
                    "color_temperature",
                    "power",
                    "brightness",
                    "identify",
                  ],
                  state_summary: "on 100%",
                  reachable: true,
                },
                {
                  id: "schreibtisch-2",
                  name: "Schreibtisch",
                  category: "lightbulb",
                  controllable: [
                    "identify",
                    "brightness",
                    "color_temperature",
                    "power",
                  ],
                  state_summary: "on 40%",
                  reachable: true,
                },
                {
                  id: "christmas",
                  name: "Christmas",
                  category: "outlet",
                  controllable: ["power", "identify"],
                  state_summary: "off",
                  reachable: true,
                },
                {
                  id: "bildschirm",
                  name: "Bildschirm",
                  category: "outlet",
                  controllable: ["identify", "power"],
                  state_summary: "on",
                  reachable: true,
                },
                {
                  id: "hue-bridge",
                  name: "Philips Hue Bridge",
                  category: "bridge",
                  controllable: ["identify"],
                  state_summary: "unknown",
                  reachable: true,
                },
                {
                  id: "sofa-schalter",
                  name: "Sofa Schalter",
                  category: "programmable_switch",
                  controllable: ["identify"],
                  state_summary: "unknown",
                  reachable: true,
                },
              ],
            },
            {
              name: "Schlafzimmer",
              devices: [
                {
                  id: "bett",
                  name: "Bett",
                  category: "lightbulb",
                  controllable: [
                    "power",
                    "brightness",
                    "color_temperature",
                    "identify",
                  ],
                  state_summary: "off",
                  reachable: true,
                },
                {
                  id: "fernseher",
                  name: "Fernseher",
                  category: "outlet",
                  controllable: ["power", "identify"],
                  state_summary: "off",
                  reachable: true,
                },
              ],
            },
            {
              name: "Status",
              devices: [
                {
                  id: "nacht",
                  name: "Nacht",
                  category: "switch",
                  controllable: ["identify", "power"],
                  state_summary: "off",
                  reachable: true,
                },
                {
                  id: "zuhause",
                  name: "Zuhause",
                  category: "switch",
                  controllable: ["power", "identify"],
                  state_summary: "on",
                  reachable: true,
                },
                {
                  id: "nami",
                  name: "Nami zu Hause",
                  category: "switch",
                  controllable: ["power", "identify"],
                  state_summary: "on",
                  reachable: true,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("parseDevices", () => {
  it("keeps controllable lights and plugs, sorted by room then name", () => {
    expect(parseDevices(JSON.stringify(deviceMap))).toEqual([
      {
        ids: ["bad-ecke"],
        name: "Bad Ecke",
        room: "Badezimmer",
        on: false,
        brightness: null,
        dimmable: false,
        reachable: true,
      },
      {
        ids: ["flur-lamp"],
        name: "Flur",
        room: "Flur",
        on: false,
        brightness: null,
        dimmable: true,
        reachable: true,
      },
      {
        ids: ["bett"],
        name: "Bett",
        room: "Schlafzimmer",
        on: false,
        brightness: null,
        dimmable: true,
        reachable: true,
      },
      {
        ids: ["fernseher"],
        name: "Fernseher",
        room: "Schlafzimmer",
        on: false,
        brightness: null,
        dimmable: false,
        reachable: true,
      },
      {
        ids: ["bildschirm"],
        name: "Bildschirm",
        room: "Wohnzimmer",
        on: true,
        brightness: null,
        dimmable: false,
        reachable: true,
      },
      {
        ids: ["christmas"],
        name: "Christmas",
        room: "Wohnzimmer",
        on: false,
        brightness: null,
        dimmable: false,
        reachable: true,
      },
      {
        ids: ["esstisch-1", "esstisch-2", "esstisch-3"],
        name: "Esstisch",
        room: "Wohnzimmer",
        on: true,
        brightness: 70,
        dimmable: true,
        reachable: true,
      },
      {
        ids: ["kueche-1", "kueche-2"],
        name: "Küche",
        room: "Wohnzimmer",
        on: false,
        brightness: null,
        dimmable: true,
        reachable: true,
      },
      {
        ids: ["schreibtisch-1", "schreibtisch-2"],
        name: "Schreibtisch",
        room: "Wohnzimmer",
        on: true,
        brightness: 100,
        dimmable: true,
        reachable: true,
      },
    ]);
  });

  it("is reachable and on when any bulb of the lamp answers", () => {
    const raw = JSON.stringify({
      homes: [
        {
          zones: [
            {
              rooms: [
                {
                  name: "Küche",
                  devices: [
                    {
                      id: "a",
                      name: "Spot",
                      category: "lightbulb",
                      controllable: ["power", "brightness"],
                      state_summary: "unreachable",
                      reachable: false,
                    },
                    {
                      id: "b",
                      name: "Spot",
                      category: "lightbulb",
                      controllable: ["power", "brightness"],
                      state_summary: "on 30%",
                      reachable: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseDevices(raw)).toEqual([
      {
        ids: ["a", "b"],
        name: "Spot",
        room: "Küche",
        on: true,
        brightness: 30,
        dimmable: true,
        reachable: true,
      },
    ]);
  });

  it("returns null for non-JSON or a homes value that is not a list", () => {
    expect(parseDevices("home: HomeClaw unreachable")).toBeNull();
    expect(parseDevices('{"homes":{}}')).toBeNull();
  });
});
