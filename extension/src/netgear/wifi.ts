// Rejoins the Mac to the router's Wi-Fi after a reboot. macOS does not
// reliably auto-rejoin once the router's SSID reappears (verified
// 2026-09-27: still off the network 4 minutes after a reboot), and without
// the LAN link nothing can reach the router to enter the SIM PIN.
//
// macOS redacts the current SSID from unprivileged processes, so the SSID
// and passphrase come from the router's own model.json (Admin role) and are
// captured before the reboot. `networksetup -setairportnetwork` needs no
// sudo; without the passphrase it fails with -3900 even for a saved network.
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const NETWORKSETUP_BIN = "/usr/sbin/networksetup";

export interface WifiCredentials {
  ssid: string;
  passphrase: string;
}

// Port — the flow depends on this; tests supply a fake.
export interface WifiRejoiner {
  rejoin(creds: WifiCredentials): Promise<boolean>;
}

export class NetworksetupWifiRejoiner implements WifiRejoiner {
  private device: string | null = null;

  async rejoin(creds: WifiCredentials): Promise<boolean> {
    const device = await this.wifiDevice();
    // networksetup exits 0 even when the join fails — the outcome is only
    // in its output.
    const { stdout, stderr } = await execFileAsync(NETWORKSETUP_BIN, [
      "-setairportnetwork",
      device,
      creds.ssid,
      creds.passphrase,
    ]);
    return joinSucceeded(`${stdout}${stderr}`);
  }

  private async wifiDevice(): Promise<string> {
    if (this.device) return this.device;
    const { stdout } = await execFileAsync(NETWORKSETUP_BIN, [
      "-listallhardwareports",
    ]);
    this.device = parseWifiDevice(stdout) ?? "en0";
    return this.device;
  }
}

// A successful `-setairportnetwork` prints nothing. A missing SSID prints
// "Could not find network <ssid>." — no "failed"/"error" in it, which made an
// off router look like a successful rejoin eight times overnight (2026-10-06).
const JOIN_FAILURE = /failed|error|could not find|not find|unable|timed out/i;

export function joinSucceeded(output: string): boolean {
  return !JOIN_FAILURE.test(output);
}

export function parseWifiDevice(listAllHardwarePorts: string): string | null {
  const match = listAllHardwarePorts.match(
    /Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/,
  );
  return match ? match[1] : null;
}
