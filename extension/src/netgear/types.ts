// Raw shape of GET /api/model.json — only the fields the parser reads.
// The real device returns far more; everything else is ignored.
export interface RouterModel {
  session: {
    userRole: string;
    secToken: string;
  };
  wwan: {
    connection: string;
    connectionText: string;
    registerNetworkDisplay: string;
    // Network registration state: "LteService" when registered,
    // "LimitedService" when the modem sees cells but may not register (seen
    // live 2026-10-06) — see docs/netgear-m2.md.
    currentNWserviceType?: string;
    roaming: boolean;
    dataUsage?: {
      generic?: {
        dataTransferred: number;
      };
    };
    profile?: {
      default?: string;
    };
    profileList?: RouterModelProfile[];
    autoconnect?: string;
    // Why the data session is down — a raw code the web UI parses as an int;
    // logged as a diagnostic for a router stuck Disconnected.
    inactivityCause?: string | number;
    // Live radio measurements — values the modem has no reading for come as 0
    // (rscp/ecio on LTE) or are absent.
    signalStrength?: RouterModelSignalStrength;
    // Carrier aggregation: how many secondary cells are bonded to the primary.
    ca?: {
      SCCcount?: number;
    };
  };
  wwanadv: {
    curBand: string;
    radioQuality: number;
    rxLevel: number;
    txLevel: number;
    cellId?: number | string;
    MCC?: string;
    MNC?: string;
    country?: string;
  };
  power: {
    battChargeLevel: number;
    charging: boolean;
    batteryState: string;
    batteryTemperature?: number; // °C
  };
  sim: {
    status: string;
    pin: {
      mode: string;
      retry: number;
    };
    puk: {
      retry: number;
    };
    iccid?: string;
    SPN?: string;
  };
  router?: {
    clientList?: {
      count: number;
      list?: RouterModelClient[];
    };
  };
  general?: {
    upTime?: number; // seconds
  };
  // Admin role only — Guest sees empty strings.
  wifi?: {
    SSID?: string;
    passPhrase?: string;
  };
  sms?: {
    ready?: boolean;
    unreadMsgs?: number;
    msgCount?: number;
    msgs?: RouterModelSmsMessage[];
  };
}

export interface RouterModelSignalStrength {
  rssi?: number; // dBm
  rscp?: number; // dBm, 3G only
  ecio?: number; // dB, 3G only
  rsrp?: number; // dBm, LTE reference signal power
  rsrq?: number; // dB, LTE reference signal quality
  bars?: number; // the router's own 0-5 indicator
  sinr?: number; // dB, LTE signal-to-interference-plus-noise
}

export interface RouterModelProfile {
  index?: number;
  id?: string;
  name?: string;
  apn?: string;
  APN?: string; // some firmware capitalises it
  username?: string;
  password?: string; // parsed into `hasPassword` only — never exposed
  authtype?: string;
  ipaddr?: string;
  type?: string;
  pdproamingtype?: string;
  roamingtype?: string; // some firmware's name for pdproamingtype
  // Bitmask the web UI reads as a number: 2 = write-deny, 4 = delete-deny,
  // 6 = both. The router sends "" for an unrestricted profile.
  access_control?: string | number;
}

export interface RouterModelSmsMessage {
  id?: string;
  rxTime?: string;
  text?: string;
  sender?: string;
  read?: boolean;
}

export interface RouterModelClient {
  IP: string;
  MAC: string;
  name: string;
  media: string;
}

// Friendly, UI-ready shape derived from RouterModel.
export interface RouterStatus {
  userRole: string; // "Guest" | "Admin"
  connection: string;
  inactivityCause: string; // raw wwan.inactivityCause, "" if absent
  connectionText: string;
  operator: string;
  // Raw wwan.currentNWserviceType, "" if absent.
  serviceType: string;
  // Registered on a mobile network: a real service type and an operator name.
  // False on "LimitedService"/"NoService" — the router sees cells but isn't
  // allowed on any, so connecting, toggling or rebooting cannot help.
  registered: boolean;
  currentlyRoaming: boolean; // wwan.roaming — registered on a roaming network right now
  mcc: string; // "" if absent
  mnc: string; // "" if absent
  country: string; // "" if absent
  band: string;
  radioQuality: number; // %
  rxLevel: number; // dBm
  txLevel: number; // dBm
  // Radio detail for the Signal Meter — null when the router doesn't report it.
  rsrp: number | null; // dBm
  rsrq: number | null; // dB
  sinr: number | null; // dB
  rssi: number | null; // dBm
  bars: number | null; // router's own 0-5 indicator
  cellId: string | null;
  caSecondaryCells: number | null; // wwan.ca.SCCcount
  dataTransferredGB: number;
  battChargeLevel: number;
  charging: boolean;
  batteryState: string;
  simStatus: string;
  simPinMode: string;
  simPinRetry: number;
  simPukRetry: number;
  connectedClients: number | null;
  connectedDevices: RouterConnectedDevice[];
  uptimeSeconds: number | null;
  batteryTemperature: number | null; // °C
  smsReady: boolean;
  smsUnread: number;
  iccid: string; // "" if absent — unverified whether populated while Locked
  simOperator: string; // sim.SPN, e.g. "Orange"
  activeProfileId: string; // "" if no active profile is reported
  profiles: RouterProfile[];
  // Raw wwan.autoconnect, which encodes data + roaming: "Never" (data off),
  // "Always" (data + roaming on), "HomeNetwork" (data on, roaming off),
  // "RoamNetwork" (data off, roaming on).
  autoconnect: string;
  roamingAllowed: boolean; // autoconnect === "Always"
  smsMessages: RouterSmsMessage[];
}

// UI-ready shape derived from RouterModelClient — trimmed to what the
// "Connected Devices" list shows.
export interface RouterConnectedDevice {
  ip: string;
  mac: string;
  name: string;
  media: string;
}

// UI-ready shape derived from RouterModelProfile — trimmed to what the APN
// profile list and "set active" flow need.
export interface RouterProfile {
  id: string; // router-assigned name-like string, e.g. "Orange 1"
  index: number; // slot order — a newly created profile gets the highest
  name: string;
  apn: string;
  username: string;
  authtype: string;
  type: string; // IP type
  // IP type used while roaming; "None" means the profile carries no data
  // when roaming. "" if the firmware reports neither field.
  pdpRoamingType: string;
  // The profile password itself is never exposed — see RouterModelProfile.
  hasPassword: boolean;
  editable: boolean; // access_control has no write-deny bit
  deletable: boolean; // no delete-deny bit and not the active profile
}

export interface RouterSmsMessage {
  id: string;
  rxTime: string;
  text: string;
  sender: string;
  read: boolean;
}

export type ApnAuthType = "None" | "PAP" | "CHAP" | "PAPCHAP";
export type ApnIpType = "IPV4" | "IPV6" | "IPV4V6";
export type ApnRoamingType = "None" | ApnIpType;

export interface CreateProfileInput {
  name: string;
  apn: string;
  username?: string;
  password?: string;
  authtype: ApnAuthType;
  type: ApnIpType;
  pdproamingtype: ApnRoamingType;
}

export interface UpdateProfileInput {
  id: string;
  name: string;
  apn: string;
  username?: string;
  // Only sent when the user actually changed it — the router keeps the
  // existing password otherwise.
  password?: string;
  authtype: ApnAuthType;
  type: ApnIpType;
  pdproamingtype: ApnRoamingType;
}

// Port — the HTTP transport client.ts depends on. The production adapter
// shells out to curl (see transport.ts); tests supply a fake.
export interface NetgearHttpResponse {
  status: number;
  body: string;
}

export interface NetgearHttp {
  get(url: string): Promise<NetgearHttpResponse>;
  postForm(
    url: string,
    fields: Record<string, string>,
    opts?: { secretFields?: Record<string, string> },
  ): Promise<NetgearHttpResponse>;
}
