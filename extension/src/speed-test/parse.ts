import { NetworkQualityResult, SpeedTestRecord } from "./types";

export function parseNetworkQuality(raw: string): NetworkQualityResult {
  return JSON.parse(raw) as NetworkQualityResult;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const BITS_PER_MBIT = 1_000_000;
const BYTES_PER_MB = 1_000_000;

export function toSpeedTestRecord(
  result: NetworkQualityResult,
  full: boolean,
  timestamp: number = Date.now(),
): SpeedTestRecord {
  const dataUsedBytes =
    result.dl_bytes_transferred + (result.ul_bytes_transferred ?? 0);
  return {
    timestamp,
    full,
    dlMbps: round1(result.dl_throughput / BITS_PER_MBIT),
    ulMbps:
      result.ul_throughput != null
        ? round1(result.ul_throughput / BITS_PER_MBIT)
        : null,
    latencyMs: round1(result.base_rtt),
    responsiveness: result.responsiveness ?? null,
    dataUsedMB: round1(dataUsedBytes / BYTES_PER_MB),
    interfaceName: result.interface_name,
  };
}
