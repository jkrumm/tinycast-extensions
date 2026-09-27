import { NetgearHttp, RouterModel, RouterStatus } from "./types";

export function parseStatus(model: RouterModel): RouterStatus {
  const bytes = model.wwan.dataUsage?.generic?.dataTransferred ?? 0;
  return {
    userRole: model.session.userRole,
    connection: model.wwan.connection,
    connectionText: model.wwan.connectionText,
    operator: model.wwan.registerNetworkDisplay,
    roaming: !!model.wwan.roaming,
    band: model.wwanadv.curBand,
    radioQuality: model.wwanadv.radioQuality,
    rxLevel: model.wwanadv.rxLevel,
    txLevel: model.wwanadv.txLevel,
    dataTransferredGB: Math.round((bytes / 1_000_000_000) * 100) / 100,
    battChargeLevel: model.power.battChargeLevel,
    charging: !!model.power.charging,
    batteryState: model.power.batteryState,
    simStatus: model.sim.status,
    simPinMode: model.sim.pin.mode,
    simPinRetry: model.sim.pin.retry,
    simPukRetry: model.sim.puk.retry,
    connectedClients: model.router?.clientList?.count ?? null,
  };
}

export interface NetgearClientOptions {
  host: string; // e.g. "http://192.168.1.1", no trailing slash
  transport: NetgearHttp;
}

const CONFIG_PATH = "/Forms/config";
const MODEL_PATH = "/api/model.json";

export class NetgearClient {
  private readonly host: string;
  private readonly transport: NetgearHttp;

  constructor(opts: NetgearClientOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.transport = opts.transport;
  }

  async getModel(): Promise<RouterModel> {
    const res = await this.transport.get(`${this.host}${MODEL_PATH}`);
    return JSON.parse(res.body) as RouterModel;
  }

  async getStatus(): Promise<RouterStatus> {
    return parseStatus(await this.getModel());
  }

  // Elevates the session's cookie jar to Admin. Read-only — safe to call
  // from tests and smoke scripts.
  async login(password: string): Promise<RouterStatus> {
    const model = await this.getModel();
    await this.transport.postForm(
      `${this.host}${CONFIG_PATH}`,
      { token: model.session.secToken },
      { stdinField: { name: "session.password", value: password } },
    );
    return this.getStatus();
  }

  // Every action below mutates the device — never call these against the
  // real router from a test or an unattended script.
  private async action(fields: Record<string, string>): Promise<void> {
    const model = await this.getModel();
    const res = await this.transport.postForm(`${this.host}${CONFIG_PATH}`, {
      ...fields,
      token: model.session.secToken,
      ok_redirect: "/success.json",
      err_redirect: "/error.json",
    });
    // The router redirects to /success.json (`{ "success": true }`) or to
    // /error.json, whose body is not even valid JSON — so match, don't parse.
    if (!/"success"\s*:\s*true/.test(res.body)) {
      throw new Error(
        `Router rejected the request: ${res.body.trim() || res.status}`,
      );
    }
  }

  reboot(): Promise<void> {
    return this.action({ "general.shutdown": "Restart" });
  }

  connect(): Promise<void> {
    return this.action({ "wwan.connect": "DefaultProfile" });
  }

  disconnect(): Promise<void> {
    return this.action({ "wwan.connect": "0" });
  }

  enterSimPin(pin: string): Promise<void> {
    return this.action({ "sim.pin.entry": pin });
  }

  enterSimPuk(puk: string, newPin: string): Promise<void> {
    return this.action({ "sim.puk.entry": puk, "sim.newpin": newPin });
  }
}
