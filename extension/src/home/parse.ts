// Pure parsing of the `home` CLI's JSON (`home scenes --json`,
// `home doctor --json`). Malformed input yields null, never a throw — the
// caller decides whether that means "keep the cache" or "show an error".

import {
  Climate,
  Device,
  Doctor,
  HomeCache,
  HomeStatus,
  Scene,
  StatusCache,
} from "./types";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// `countKey` differs: the CLI says `action_count`, our own cache `actionCount`.
const toScene =
  (countKey: string) =>
  (v: unknown): Scene[] => {
    if (!isObject(v)) return [];
    const id = str(v.id);
    const name = str(v.name);
    if (!id || !name) return [];
    const rooms = Array.isArray(v.rooms)
      ? v.rooms.filter((r): r is string => typeof r === "string")
      : [];
    const actionCount =
      typeof v[countKey] === "number" ? (v[countKey] as number) : 0;
    return [{ id, name, rooms, actionCount }];
  };

function toScenes(value: unknown, countKey: string): Scene[] | null {
  return Array.isArray(value) ? value.flatMap(toScene(countKey)) : null;
}

export function parseScenes(raw: string): Scene[] | null {
  return toScenes(parseJson(raw), "action_count");
}

function toDoctor(value: unknown): Doctor | null {
  if (!isObject(value)) return null;
  const list = (v: unknown): Json[] =>
    Array.isArray(v) ? v.filter(isObject) : [];
  return {
    total: typeof value.total === "number" ? value.total : 0,
    unreachable: list(value.unreachable).flatMap((a) => {
      const name = str(a.name);
      return name
        ? [{ name, room: str(a.room), manufacturer: str(a.manufacturer) }]
        : [];
    }),
    lowBattery: list(value.low_battery).flatMap((a) => {
      const name = str(a.name);
      return name && typeof a.battery === "number"
        ? [{ name, room: str(a.room), battery: a.battery }]
        : [];
    }),
  };
}

export function parseDoctor(raw: string): Doctor | null {
  return toDoctor(parseJson(raw));
}

// ─── Lights (`home device-map --json`) ─────────────────────────────────────

// The virtual switches (Nacht, Zuhause, Nami zu Hause) live in this room; they
// are not lamps.
const STATUS_ROOM = "Status";
const LIGHT_CATEGORIES = ["lightbulb", "outlet", "switch"];

interface Member {
  id: string;
  name: string;
  room: string;
  on: boolean;
  brightness: number | null;
  dimmable: boolean;
  reachable: boolean;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const objects = (v: unknown): Json[] => arr(v).filter(isObject);

// The accessory as a lamp member; none unless it is a controllable light or plug.
function toMember(room: string, device: Json): Member[] {
  const id = str(device.id);
  const name = str(device.name);
  const category = str(device.category);
  const controllable = arr(device.controllable);
  if (!id || !name || !category || !LIGHT_CATEGORIES.includes(category))
    return [];
  if (!controllable.includes("power")) return [];
  const summary = str(device.state_summary) ?? "";
  const percent = /(\d{1,3})\s*%/.exec(summary);
  return [
    {
      id,
      name,
      room,
      on: /^on\b/i.test(summary),
      brightness: percent ? Number(percent[1]) : null,
      dimmable: controllable.includes("brightness"),
      reachable: device.reachable !== false && !/unreachable/i.test(summary),
    },
  ];
}

// Members sharing a room and name are one lamp made of several bulbs.
function toDevice(members: Member[]): Device {
  const levels = members.flatMap((m) =>
    m.brightness === null ? [] : [m.brightness],
  );
  const first = members[0];
  return {
    ids: members.map((m) => m.id),
    name: first.name,
    room: first.room,
    on: members.some((m) => m.on),
    brightness: levels.length > 0 ? Math.max(...levels) : null,
    dimmable: members.every((m) => m.dimmable),
    reachable: members.some((m) => m.reachable),
  };
}

const byRoomThenName = (a: Device, b: Device) =>
  a.room.localeCompare(b.room, "de") || a.name.localeCompare(b.name, "de");

export function parseDevices(raw: string): Device[] | null {
  const value = parseJson(raw);
  if (!isObject(value) || !Array.isArray(value.homes)) return null;
  const members = objects(value.homes)
    .flatMap((home) => objects(home.zones))
    .flatMap((zone) => objects(zone.rooms))
    .flatMap((room) => {
      const name = str(room.name);
      if (!name || name === STATUS_ROOM) return [];
      return objects(room.devices).flatMap((device) => toMember(name, device));
    });
  const lamps = new Map<string, Member[]>();
  for (const member of members) {
    const key = JSON.stringify([member.room, member.name]);
    lamps.set(key, [...(lamps.get(key) ?? []), member]);
  }
  return Array.from(lamps.values(), toDevice).sort(byRoomThenName);
}

const isDevice = (v: unknown): v is Device =>
  isObject(v) &&
  typeof v.name === "string" &&
  typeof v.room === "string" &&
  Array.isArray(v.ids) &&
  typeof v.on === "boolean" &&
  (typeof v.brightness === "number" || v.brightness === null) &&
  typeof v.dimmable === "boolean" &&
  typeof v.reachable === "boolean";

// The LocalStorage entry written by `serializeCache`.
export function parseCache(raw: string): HomeCache | null {
  const value = parseJson(raw);
  if (!isObject(value) || typeof value.fetchedAt !== "number") return null;
  const scenes = toScenes(value.scenes, "actionCount");
  if (!scenes) return null;
  const doctor =
    isObject(value.doctor) && Array.isArray(value.doctor.lowBattery)
      ? (value.doctor as unknown as Doctor)
      : null;
  // A cache written before Lights existed has no devices: an empty list.
  const devices = Array.isArray(value.devices)
    ? value.devices.filter(isDevice)
    : [];
  return { scenes, doctor, devices, fetchedAt: value.fetchedAt };
}

export const serializeCache = (cache: HomeCache): string =>
  JSON.stringify(cache);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

function toClimate(value: unknown): Climate | null {
  if (!isObject(value)) return null;
  return {
    sensor: str(value.sensor),
    reachable: bool(value.reachable),
    temperatureC: num(value.temperature_c ?? value.temperatureC),
    humidityPct: num(value.humidity_pct ?? value.humidityPct),
    batteryPct: num(value.battery_pct ?? value.batteryPct),
  };
}

function toStatus(value: unknown): HomeStatus | null {
  if (!isObject(value)) return null;
  return {
    climate: toClimate(value.climate),
    namiHome: bool(value.nami_home ?? value.namiHome),
    someoneHome: bool(value.someone_home ?? value.someoneHome),
  };
}

export const parseStatus = (raw: string): HomeStatus | null =>
  toStatus(parseJson(raw));

// The LocalStorage entry written by `serializeStatusCache` (camelCase).
export function parseStatusCache(raw: string): StatusCache | null {
  const value = parseJson(raw);
  if (!isObject(value) || typeof value.fetchedAt !== "number") return null;
  const status = toStatus(value.status);
  return status
    ? {
        status,
        fetchedAt: value.fetchedAt,
        climateAt: num(value.climateAt) ?? value.fetchedAt,
      }
    : null;
}

export const serializeStatusCache = (cache: StatusCache): string =>
  JSON.stringify(cache);
