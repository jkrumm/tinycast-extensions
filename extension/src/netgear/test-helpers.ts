// Shared fakes for netgear/*.test.ts — a scripted transport, an in-memory
// SimPinStore, and a deterministic fake clock, so `flows.test.ts` and
// `watchdog.test.ts` don't duplicate the same fixtures. No `@raycast/api`
// import, same reason as the modules under test.

import {
  NetgearHttp,
  NetgearHttpResponse,
  RouterModel,
  RouterStatus,
} from "./types";
import { SimPinStore } from "./pin-store";
import { WifiCredentials, WifiRejoiner } from "./wifi";
import { WifiCredsStore } from "./wifi-creds-store";

export const ICCID = "8900000000000000001";

export const BASE_STATUS: RouterStatus = {
  userRole: "Admin",
  connection: "Connected",
  inactivityCause: "",
  connectionText: "4G+",
  operator: "Fakecom",
  serviceType: "LteService",
  registered: true,
  currentlyRoaming: false,
  mcc: "",
  mnc: "",
  country: "",
  band: "LTE B7",
  radioQuality: 50,
  rxLevel: -90,
  txLevel: 10,
  rsrp: -98,
  rsrq: -12,
  sinr: 4,
  rssi: -68,
  bars: 2,
  cellId: "25480193",
  caSecondaryCells: 1,
  dataTransferredGB: 0,
  battChargeLevel: 80,
  charging: true,
  batteryState: "Normal",
  simStatus: "Ready",
  simPinMode: "Enabled",
  simPinRetry: 3,
  simPukRetry: 10,
  connectedClients: null,
  connectedDevices: [],
  uptimeSeconds: null,
  batteryTemperature: null,
  smsReady: false,
  smsUnread: 0,
  iccid: ICCID,
  simOperator: "Fakecom",
  activeProfileId: "",
  profiles: [],
  autoconnect: "",
  roamingAllowed: false,
  smsMessages: [],
};

export function buildModel(overrides: {
  sim?: RouterModel["sim"];
  connection?: string;
}): RouterModel {
  return {
    session: { userRole: "Admin", secToken: "fake-token" },
    wwan: {
      connection: overrides.connection ?? "Connected",
      connectionText: "4G+",
      registerNetworkDisplay: "Fakecom",
      currentNWserviceType: "LteService",
      roaming: false,
      signalStrength: { rssi: -68, rsrp: -98, rsrq: -12, bars: 2, sinr: 4 },
    },
    wwanadv: { curBand: "LTE B7", radioQuality: 50, rxLevel: -90, txLevel: 10 },
    power: { battChargeLevel: 80, charging: true, batteryState: "Normal" },
    sim: overrides.sim ?? {
      status: "Ready",
      pin: { mode: "Enabled", retry: 3 },
      puk: { retry: 10 },
      iccid: ICCID,
      SPN: "Fakecom",
    },
  };
}

export const SUCCESS_BODY = '{ "success": true }';
// What /error.json looks like — not even valid JSON.
export const REJECTED_BODY = '{ "errno": , "errdetail": "" }';

// Array-indexed, sticky at the last entry — same pattern as
// client.test.ts's FakeNetgearHttp, plus an Error sentinel so a "the router
// is unreachable mid-reboot" call can be scripted deterministically.
export class ScriptedNetgearHttp implements NetgearHttp {
  private calls = 0;
  public postCalls: { url: string; fields: Record<string, string> }[] = [];

  private posts = 0;

  // `postBodies` scripts each POST's response body in order (sticky at the
  // last entry); omitted, every POST succeeds. Use REJECTED_BODY to make the
  // router refuse an action.
  constructor(
    private readonly script: Array<RouterModel | Error>,
    private readonly postBodies: string[] = [SUCCESS_BODY],
  ) {}

  async get(): Promise<NetgearHttpResponse> {
    const entry = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    if (entry instanceof Error) throw entry;
    return { status: 200, body: JSON.stringify(entry) };
  }

  async postForm(
    url: string,
    fields: Record<string, string>,
  ): Promise<NetgearHttpResponse> {
    this.postCalls.push({ url, fields });
    const body =
      this.postBodies[Math.min(this.posts, this.postBodies.length - 1)];
    this.posts++;
    return { status: 200, body };
  }
}

// A tiny stateful router for the data off/on soft reset: `wwan.autoconnect`
// Never drops the connection (unless `dropOnNever` is false), Always
// reconnects it unless the router is `stuck` (connect requests accepted but
// ignored, like the 2026-10-04 incident) — a toggle clears `stuck` only when
// `toggleFixes`. Records every autoconnect write and reboot.
export class DataRouterHttp implements NetgearHttp {
  public connection: string;
  public autoconnect = "Always";
  public stuck: boolean;
  public autoconnectWrites: string[] = [];
  public reboots = 0;
  private readonly dropOnNever: boolean;
  private readonly toggleFixes: boolean;

  constructor(
    opts: {
      connection?: string;
      stuck?: boolean;
      dropOnNever?: boolean;
      toggleFixes?: boolean;
    } = {},
  ) {
    this.connection = opts.connection ?? "Connected";
    this.stuck = opts.stuck ?? false;
    this.dropOnNever = opts.dropOnNever ?? true;
    this.toggleFixes = opts.toggleFixes ?? true;
  }

  async get(): Promise<NetgearHttpResponse> {
    const model = buildModel({ connection: this.connection });
    model.wwan.autoconnect = this.autoconnect;
    return { status: 200, body: JSON.stringify(model) };
  }

  async postForm(
    _url: string,
    fields: Record<string, string>,
  ): Promise<NetgearHttpResponse> {
    const autoconnect = fields["wwan.autoconnect"];
    if (autoconnect !== undefined) this.applyAutoconnect(autoconnect);
    else if (fields["wwan.connect"] === "DefaultProfile") {
      if (!this.stuck) this.connection = "Connected";
    } else if (fields["wwan.connect"] === "0") this.connection = "Disconnected";
    else if ("general.shutdown" in fields) this.reboots++;
    else return { status: 200, body: REJECTED_BODY };
    return { status: 200, body: SUCCESS_BODY };
  }

  private applyAutoconnect(value: string): void {
    this.autoconnectWrites.push(value);
    const wasNever = this.autoconnect === "Never";
    this.autoconnect = value;
    if (value === "Never") {
      if (this.dropOnNever) this.connection = "Disconnected";
      return;
    }
    if (!wasNever) return;
    if (this.toggleFixes) this.stuck = false;
    if (!this.stuck) this.connection = "Connected";
  }
}

export class FakePinStore implements SimPinStore {
  private store = new Map<string, string>();
  public setCalls: { iccid: string; pin: string }[] = [];
  public deleteCalls: string[] = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [iccid, pin] of Object.entries(seed)) this.store.set(iccid, pin);
  }

  async get(iccid: string): Promise<string | null> {
    return this.store.get(iccid) ?? null;
  }

  async set(iccid: string, pin: string): Promise<void> {
    this.store.set(iccid, pin);
    this.setCalls.push({ iccid, pin });
  }

  async delete(iccid: string): Promise<void> {
    this.store.delete(iccid);
    this.deleteCalls.push(iccid);
  }

  async take(iccid: string): Promise<string | null> {
    const pin = this.store.get(iccid) ?? null;
    this.store.delete(iccid);
    return pin;
  }

  public lastIccid: string | null = null;

  async getLastIccid(): Promise<string | null> {
    return this.lastIccid;
  }

  async setLastIccid(iccid: string): Promise<void> {
    this.lastIccid = iccid;
  }
}

// Fake WifiCredsStore + WifiRejoiner — shared by flows.test.ts's
// ensureRouterReachable tests and watchdog.test.ts's rejoin-rule tests.
export class FakeWifiCredsStore implements WifiCredsStore {
  public setCalls: WifiCredentials[] = [];
  constructor(private stored: WifiCredentials | null = null) {}
  async get(): Promise<WifiCredentials | null> {
    return this.stored;
  }
  async set(creds: WifiCredentials): Promise<void> {
    this.stored = creds;
    this.setCalls.push(creds);
  }
}

export class FakeWifiRejoiner implements WifiRejoiner {
  public rejoinCalls: WifiCredentials[] = [];
  constructor(private readonly result: boolean = true) {}
  async rejoin(creds: WifiCredentials): Promise<boolean> {
    this.rejoinCalls.push(creds);
    return this.result;
  }
}

// Deterministic fake clock: `now()` returns an ever-increasing counter that
// jumps by `stepMs` on every call, so every timeout in flows.ts elapses
// "instantly" in wall-clock terms while still exercising the real
// deadline-comparison logic. `sleep()` never actually waits.
export function fakeClock(stepMs: number) {
  let t = 0;
  return {
    now: () => {
      const v = t;
      t += stepMs;
      return v;
    },
    sleep: async () => {},
  };
}
