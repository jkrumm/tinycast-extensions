import { ClimatePoint } from "./climate";

export interface Scene {
  id: string;
  name: string;
  rooms: string[];
  actionCount: number;
}

export interface UnreachableAccessory {
  name: string;
  room: string | null;
  manufacturer: string | null;
}

export interface LowBatteryAccessory {
  name: string;
  room: string | null;
  battery: number;
}

// `home doctor --json`, narrowed to what the command shows.
export interface Doctor {
  total: number;
  unreachable: UnreachableAccessory[];
  lowBattery: LowBatteryAccessory[];
}

// What the command keeps in LocalStorage between opens.
export interface HomeCache {
  scenes: Scene[];
  doctor: Doctor | null;
  fetchedAt: number;
}

export interface Climate {
  sensor: string | null;
  reachable: boolean | null;
  temperatureC: number | null;
  humidityPct: number | null;
  batteryPct: number | null;
}

// `home status --json`, every field nullable.
export interface HomeStatus {
  climate: Climate | null;
  namiHome: boolean | null;
  someoneHome: boolean | null;
}

// What the status surfaces keep in LocalStorage between opens.
export interface StatusCache {
  status: HomeStatus;
  fetchedAt: number;
  // When the climate numbers were actually read; older than `fetchedAt` while
  // the sensor is unreachable and last-known values are shown.
  climateAt: number;
}

// Everything the menu-bar command renders.
export interface MenuBarData {
  status: StatusCache | null;
  scenes: Scene[];
  climate: ClimatePoint[] | null; // null: unavailable, line omitted
  error: string | null;
}
