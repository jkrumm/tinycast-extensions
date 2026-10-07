import {
  CreateProfileInput,
  NetgearHttp,
  RouterConnectedDevice,
  RouterModel,
  RouterProfile,
  RouterSmsMessage,
  RouterStatus,
  UpdateProfileInput,
} from "./types";
import { WifiCredentials } from "./wifi";
import { isRouterRejection } from "./errors";

const ACCESS_WRITE_DENY = 2;
const ACCESS_DELETE_DENY = 4;

// The router reports numbers as numbers, but a missing reading may be absent
// or empty — anything not finite is "no reading", never 0.
function reading(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

const UNREGISTERED_SERVICE_TYPES: ReadonlySet<string> = new Set([
  "",
  "LimitedService",
  "NoService",
]);

export function parseStatus(model: RouterModel): RouterStatus {
  const bytes = model.wwan.dataUsage?.generic?.dataTransferred ?? 0;
  const connectedDevices: RouterConnectedDevice[] = (
    model.router?.clientList?.list ?? []
  )
    .filter((c) => c.MAC) // the router pads the list with a trailing {}
    .map((c) => ({ ip: c.IP, mac: c.MAC, name: c.name, media: c.media }));

  const activeProfileId = model.wwan.profile?.default ?? "";
  const profiles: RouterProfile[] = (model.wwan.profileList ?? [])
    .filter((p) => p.id) // the router pads the list with a trailing {}
    .map((p) => {
      const accessControl = Number(p.access_control) || 0;
      return {
        id: p.id ?? "",
        index: p.index ?? 0,
        name: p.name ?? "",
        apn: p.apn ?? p.APN ?? "",
        username: p.username ?? "",
        authtype: p.authtype ?? "",
        type: p.type ?? "",
        pdpRoamingType: p.pdproamingtype ?? p.roamingtype ?? "",
        // The password itself stops here — only its presence goes on.
        hasPassword: !!p.password,
        editable: (accessControl & ACCESS_WRITE_DENY) === 0,
        deletable:
          (accessControl & ACCESS_DELETE_DENY) === 0 &&
          p.id !== activeProfileId,
      };
    });

  const smsMessages: RouterSmsMessage[] = (model.sms?.msgs ?? [])
    .filter((m) => m.id) // the router pads the list with a trailing {}
    .map((m) => ({
      id: m.id ?? "",
      rxTime: m.rxTime ?? "",
      text: m.text ?? "",
      sender: m.sender ?? "",
      read: !!m.read,
    }));

  const autoconnect = model.wwan.autoconnect ?? "";
  const signal = model.wwan.signalStrength;
  const cellId = model.wwanadv.cellId;
  const serviceType = model.wwan.currentNWserviceType ?? "";

  return {
    userRole: model.session.userRole,
    connection: model.wwan.connection,
    inactivityCause:
      model.wwan.inactivityCause === undefined
        ? ""
        : String(model.wwan.inactivityCause),
    connectionText: model.wwan.connectionText,
    operator: model.wwan.registerNetworkDisplay,
    serviceType,
    // A Connected data session proves registration — so a firmware that
    // omits `currentNWserviceType` can never silence the watchdog.
    registered:
      model.wwan.connection === "Connected" ||
      (!UNREGISTERED_SERVICE_TYPES.has(serviceType) &&
        model.wwan.registerNetworkDisplay !== ""),
    currentlyRoaming: !!model.wwan.roaming,
    mcc: model.wwanadv.MCC ?? "",
    mnc: model.wwanadv.MNC ?? "",
    country: model.wwanadv.country ?? "",
    band: model.wwanadv.curBand,
    radioQuality: model.wwanadv.radioQuality,
    rxLevel: model.wwanadv.rxLevel,
    txLevel: model.wwanadv.txLevel,
    rsrp: reading(signal?.rsrp),
    rsrq: reading(signal?.rsrq),
    sinr: reading(signal?.sinr),
    rssi: reading(signal?.rssi),
    bars: reading(signal?.bars),
    cellId: cellId === undefined || cellId === "" ? null : String(cellId),
    caSecondaryCells: reading(model.wwan.ca?.SCCcount),
    dataTransferredGB: Math.round((bytes / 1_000_000_000) * 100) / 100,
    battChargeLevel: model.power.battChargeLevel,
    charging: !!model.power.charging,
    batteryState: model.power.batteryState,
    simStatus: model.sim.status,
    simPinMode: model.sim.pin.mode,
    simPinRetry: model.sim.pin.retry,
    simPukRetry: model.sim.puk.retry,
    connectedClients: model.router?.clientList?.count ?? null,
    connectedDevices,
    uptimeSeconds: model.general?.upTime ?? null,
    batteryTemperature: model.power.batteryTemperature ?? null,
    smsReady: model.sms?.ready ?? false,
    smsUnread: model.sms?.unreadMsgs ?? 0,
    iccid: model.sim.iccid ?? "",
    simOperator: model.sim.SPN ?? "",
    activeProfileId,
    profiles,
    autoconnect,
    roamingAllowed: autoconnect === "Always",
    smsMessages,
  };
}

export interface NetgearClientOptions {
  host: string; // e.g. "http://192.168.1.1", no trailing slash
  transport: NetgearHttp;
}

const CONFIG_PATH = "/Forms/config";
const PIN_CHANGE_PATH = "/Forms/pinChange";
const PROFILE_PATH = "/Forms/profile";
const MODEL_PATH = "/api/model.json";

export class NetgearClient {
  private readonly host: string;
  private readonly transport: NetgearHttp;
  private password: string | null = null;

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

  // Kept out of RouterStatus on purpose — the passphrase must never end up
  // in UI state. Empty unless the session is Admin.
  async getWifiCredentials(): Promise<WifiCredentials | null> {
    const wifi = (await this.getModel()).wifi;
    if (!wifi?.SSID || !wifi.passPhrase) return null;
    return { ssid: wifi.SSID, passphrase: wifi.passPhrase };
  }

  // Elevates the session's cookie jar to Admin. Read-only — safe to call
  // from tests and smoke scripts. The router treats a password POST as a
  // TOGGLE (verified live 2026-10-04): on a session that is already Admin it
  // logs out to Guest, after which every write is refused with `errno 1`.
  // So this only posts when the session isn't Admin yet, and verifies the
  // result. The password is kept so `action()` can re-elevate a session
  // that expired or was toggled by another process sharing the cookie jar.
  async login(password: string): Promise<RouterStatus> {
    this.password = password;
    const model = await this.getModel();
    if (model.session.userRole === "Admin") return parseStatus(model);
    await this.transport.postForm(
      `${this.host}${CONFIG_PATH}`,
      { token: model.session.secToken },
      { secretFields: { "session.password": password } },
    );
    const status = await this.getStatus();
    if (status.userRole !== "Admin") {
      throw new Error(
        "Router login failed — check the Netgear admin password preference.",
      );
    }
    return status;
  }

  // Every action below mutates the device — never call these against the
  // real router from a test or an unattended script. `secretFields` carries
  // whatever must never land on curl's argv (PIN, PUK, new PIN, APN
  // password) — see transport.ts.
  private async action(
    label: string,
    fields: Record<string, string>,
    path: string = CONFIG_PATH,
    secretFields?: Record<string, string>,
  ): Promise<void> {
    try {
      await this.postAction(label, fields, path, secretFields);
    } catch (e) {
      // A refusal on a session that is no longer Admin (expired, or toggled
      // to Guest by a second login sharing the cookie jar) is fixable: log in
      // again and retry once. Anything else is a real refusal.
      if (!this.password || !/^Router rejected/.test((e as Error).message)) {
        throw e;
      }
      const model = await this.getModel();
      if (model.session.userRole === "Admin") throw e;
      await this.login(this.password);
      await this.postAction(label, fields, path, secretFields);
    }
  }

  private async postAction(
    label: string,
    fields: Record<string, string>,
    path: string,
    secretFields?: Record<string, string>,
  ): Promise<void> {
    const model = await this.getModel();
    const res = await this.transport.postForm(
      `${this.host}${path}`,
      {
        ...fields,
        token: model.session.secToken,
        ok_redirect: "/success.json",
        err_redirect: "/error.json",
      },
      secretFields ? { secretFields } : undefined,
    );
    // The router redirects to /success.json (`{ "success": true }`) or to
    // /error.json, whose body is not even valid JSON — so match, don't parse.
    if (!/"success"\s*:\s*true/.test(res.body)) {
      throw new Error(
        `Router rejected the ${label} request: ${res.body.trim() || res.status}`,
      );
    }
  }

  // The router's web UI sends `restart` from its Restart button and `Restart`
  // after saving some settings, and the router has accepted and rejected both
  // spellings at different times (errno 1 / errdetail general.shutdown) — so
  // try the button's value first and fall back to the other once, but only on
  // a refusal (an unreachable router isn't retried).
  async reboot(): Promise<void> {
    try {
      return await this.action("reboot", { "general.shutdown": "restart" });
    } catch (first) {
      if (!isRouterRejection(first)) throw first;
    }
    try {
      return await this.action("reboot", { "general.shutdown": "Restart" });
    } catch (second) {
      if (!isRouterRejection(second)) throw second;
      const body = (second as Error).message.replace(/^[^:]*:\s*/, "");
      throw new Error(
        `Router rejected the reboot request (tried both variants, "restart" and "Restart"): ${body}`,
      );
    }
  }

  connect(): Promise<void> {
    return this.action("connect", { "wwan.connect": "DefaultProfile" });
  }

  disconnect(): Promise<void> {
    return this.action("disconnect", { "wwan.connect": "0" });
  }

  enterSimPin(pin: string): Promise<void> {
    return this.action("SIM PIN", {}, CONFIG_PATH, { "sim.pin.entry": pin });
  }

  // The web UI routes a non-empty `sim.puk.entry`/`sim.newpin` pair to
  // /Forms/pinChange, not /Forms/config.
  enterSimPuk(puk: string, newPin: string): Promise<void> {
    return this.action("SIM PUK", {}, PIN_CHANGE_PATH, {
      "sim.puk.entry": puk,
      "sim.newpin": newPin,
    });
  }

  changeSimPin(oldPin: string, newPin: string): Promise<void> {
    return this.action("SIM PIN change", {}, PIN_CHANGE_PATH, {
      "sim.pin.change": oldPin,
      "sim.newpin": newPin,
    });
  }

  setSimPinLock(opts: { enabled: boolean; pin: string }): Promise<void> {
    const field = opts.enabled ? "sim.pin.enable" : "sim.pin.disable";
    return this.action("SIM PIN lock", {}, CONFIG_PATH, { [field]: opts.pin });
  }

  setActiveProfile(id: string): Promise<void> {
    return this.action("APN profile", {
      "wwan.profile.default": id,
      "wwan.profile.promptForApnSelection": "false",
    });
  }

  // The router assigns the new profile's id — callers re-read `getStatus()`
  // and find the created entry by name.
  createProfile(input: CreateProfileInput): Promise<void> {
    const fields: Record<string, string> = {
      action: "create",
      "profile.name": input.name,
      "profile.apn": input.apn,
      "profile.username": input.username ?? "",
      "profile.authtype": input.authtype,
      "profile.type": input.type,
      "profile.pdproamingtype": input.pdproamingtype,
      "profile.ipaddr": "0.0.0.0",
    };
    const secretFields = input.password
      ? { "profile.password": input.password }
      : undefined;
    if (!secretFields) fields["profile.password"] = "";
    return this.action(
      "create APN profile",
      fields,
      PROFILE_PATH,
      secretFields,
    );
  }

  // The web UI sends every field except `ipaddr`, and `profile.password` only
  // when the user typed a new one (an unchanged secret field stays out).
  updateProfile(input: UpdateProfileInput): Promise<void> {
    const fields: Record<string, string> = {
      action: "update",
      "profile.id": input.id,
      "profile.name": input.name,
      "profile.apn": input.apn,
      "profile.username": input.username ?? "",
      "profile.type": input.type,
      "profile.pdproamingtype": input.pdproamingtype,
      "profile.authtype": input.authtype,
    };
    const secretFields = input.password
      ? { "profile.password": input.password }
      : undefined;
    return this.action(
      "update APN profile",
      fields,
      PROFILE_PATH,
      secretFields,
    );
  }

  // The router refuses to delete the active profile or a delete-deny one.
  deleteProfile(id: string): Promise<void> {
    return this.action(
      "delete APN profile",
      { action: "delete", "profile.id": id },
      PROFILE_PATH,
    );
  }

  setRoaming(allow: boolean): Promise<void> {
    return this.action("roaming", {
      "wwan.autoconnect": allow ? "Always" : "HomeNetwork",
    });
  }

  // Data off/on for the soft reset (see flows.ts `toggleData`): `Never` drops
  // the data session, `Always` brings it back with roaming allowed. Callers
  // must always end on `true` — `Never` left behind is an outage.
  setDataEnabled(enabled: boolean): Promise<void> {
    return this.action("data", {
      "wwan.autoconnect": enabled ? "Always" : "Never",
    });
  }

  markSmsRead(id: string): Promise<void> {
    return this.action("SMS mark-read", { "sms.readId": id });
  }

  deleteSms(id: string): Promise<void> {
    return this.action("SMS delete", { "sms.deleteId": id });
  }
}
