import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { BatterySnapshot } from "./types";
import { parseBattStatus, parseIoregBattery, parsePauseUntil } from "./parse";

const execFileAsync = promisify(execFile);

const BATT_BIN = "/opt/homebrew/opt/batt/bin/batt";
const IOREG_BIN = "/usr/sbin/ioreg";
const PAUSE_FILE = `${homedir()}/.config/batt/pause-until`;

async function readPauseFile(): Promise<string | null> {
  try {
    return await readFile(PAUSE_FILE, "utf8");
  } catch {
    return null;
  }
}

export async function collectBatterySnapshot(): Promise<BatterySnapshot> {
  const [{ stdout: battJson }, { stdout: ioregText }, pauseRaw] =
    await Promise.all([
      execFileAsync(BATT_BIN, ["status", "--json"]),
      execFileAsync(IOREG_BIN, ["-rn", "AppleSmartBattery"]),
      readPauseFile(),
    ]);

  return {
    status: parseBattStatus(battJson),
    hardware: parseIoregBattery(ioregText),
    pauseUntilEpoch: parsePauseUntil(pauseRaw),
  };
}
