import { BattStatus, HardwareBatteryInfo } from "./types";

export function parseBattStatus(raw: string): BattStatus {
  return JSON.parse(raw) as BattStatus;
}

// Anchored to a whole line with spaces around `=` — ioreg prints top-level
// keys as `  "Key" = 123\n`, one per line, but nested structs (e.g.
// `"BatteryData"`'s value) are inlined on a single line as `"Key"=123` with
// no surrounding spaces. Without the anchor, a nested key with the same name
// (`BatteryData` also carries its own `"CycleCount"`) can match first.
function ioregNumber(text: string, key: string): number | null {
  const match = text.match(new RegExp(`^\\s*"${key}" = (-?\\d+)\\s*$`, "m"));
  return match ? Number(match[1]) : null;
}

// Parses the plaintext `ioreg -arn AppleSmartBattery` tree (not
// `-d2`/plutil JSON — see types.ts for why) for the handful of top-level
// keys this command shows.
export function parseIoregBattery(text: string): HardwareBatteryInfo | null {
  const cycleCount = ioregNumber(text, "CycleCount");
  const designCapacityMah = ioregNumber(text, "DesignCapacity");
  const rawMaxCapacityMah = ioregNumber(text, "AppleRawMaxCapacity");
  const temperatureRaw = ioregNumber(text, "Temperature");
  if (
    cycleCount === null ||
    designCapacityMah === null ||
    rawMaxCapacityMah === null ||
    temperatureRaw === null
  ) {
    return null;
  }
  return {
    cycleCount,
    designCapacityMah,
    rawMaxCapacityMah,
    temperatureCelsius: temperatureRaw / 100,
  };
}

export function parsePauseUntil(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function batteryHealthPercent(hardware: HardwareBatteryInfo): number {
  return Math.round(
    (hardware.rawMaxCapacityMah / hardware.designCapacityMah) * 100,
  );
}
