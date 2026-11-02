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
