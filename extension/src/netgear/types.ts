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
    roaming: boolean;
    dataUsage?: {
      generic?: {
        dataTransferred: number;
      };
    };
  };
  wwanadv: {
    curBand: string;
    radioQuality: number;
    rxLevel: number;
    txLevel: number;
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
  sms?: {
    ready?: boolean;
    unreadMsgs?: number;
  };
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
  connectionText: string;
  operator: string;
  roaming: boolean;
  band: string;
  radioQuality: number; // %
  rxLevel: number; // dBm
  txLevel: number; // dBm
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
}

// UI-ready shape derived from RouterModelClient — trimmed to what the
// "Connected Devices" list shows.
export interface RouterConnectedDevice {
  ip: string;
  mac: string;
  name: string;
  media: string;
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
    opts?: { stdinField?: { name: string; value: string } },
  ): Promise<NetgearHttpResponse>;
}
