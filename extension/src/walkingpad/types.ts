// The WalkingPad host's `GET /status`, narrowed to what the commands show
// (contract: walkingpad-mac docs/protocol.md §8). Every field can be missing.

export interface Totals {
  durationS: number;
  distanceM: number;
  steps: number;
  kcal: number;
}

export interface WalkSession extends Totals {
  startedAt: string | null;
  avgSpeedKmh: number | null;
  maxSpeedKmh: number | null;
}

export interface PadStatus {
  connected: boolean;
  beltState: string | null; // "active" | "starting" | "stopping" | "stopped" | "standby" | …
  speedKmh: number | null;
  session: WalkSession | null;
  today: Totals;
  adapterError: string | null; // why the host's Bluetooth adapter is down
}

// What the chain command → host → pad is doing, as one state.
export type Phase =
  "padDisconnected" | "standby" | "starting" | "active" | "stopping";

export type WalkingPadErrorKind =
  | "unconfigured" // no host URL / no token on this Mac
  | "unauthorized" // 401
  | "timeout"
  | "unreachable" // refused, DNS, network down
  | "http" // any other non-2xx
  | "unreadable"; // 2xx with a body that is not a status
