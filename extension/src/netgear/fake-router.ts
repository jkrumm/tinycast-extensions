// An in-process fake of the Netgear M2's web API, close enough for the real
// `CurlNetgearHttp` transport to talk to it over 127.0.0.1: the session
// cookie dance (`/api/model.json` → 302 → `/sess_cd_tmp`), a per-session
// `secToken` and Guest/Admin role, form POSTs that answer with a 302 to
// `/success.json` or `/error.json` (whose body is not valid JSON, like the
// real one), timed Connecting/Disconnecting transitions, and a reboot during
// which the router is unreachable.
//
// It exists so the click-through and the integration suite
// (`fake-router.integration.test.ts`) never need the real router — see
// AGENTS.md § Safety. Dev/test tooling only: nothing in a command bundle
// imports it. The model is built from `fixtures/model-admin.fixture.json`.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "net";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { RouterModel, RouterModelProfile } from "./types";

export type FakeConnection =
  | "Connected"
  | "Disconnected"
  | "Connecting"
  | "Disconnecting";

export interface FakeProfile {
  index: number;
  id: string;
  name: string;
  apn: string;
  username: string;
  password: string; // real value — the model shows it, parseStatus must not
  authtype: string;
  type: string;
  pdproamingtype: string;
  // Bitmask: 2 = write-deny, 4 = delete-deny, 6 = both.
  accessControl: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  fields: Record<string, string>; // POSTs only
}

export interface FakeRouterState {
  connection: FakeConnection;
  simStatus: "Ready" | "Locked" | "Blocked";
  simPin: string;
  simPinEnabled: boolean;
  simPinRetry: number;
  autoconnect: string;
  roamingNow: boolean; // wwan.roaming — set by tests, the fake has no network
  // wwan.currentNWserviceType / registerNetworkDisplay — set by tests; a
  // "LimitedService" router with no operator is the 2026-10-06 incident.
  serviceType: string;
  operator: string;
  activeProfileId: string;
  profiles: FakeProfile[];
  rebootingUntil: number; // epoch ms; unreachable until then
  // The router's own battery, set by tests — the fake never drains it. A
  // test "kills" the router by setting `rebootingUntil` far ahead.
  battChargeLevel: number;
  charging: boolean;
  // Models a router wedged in Disconnected: connect requests are accepted but
  // do nothing. Set by tests; a reboot clears it, like the real incident.
  ignoreConnect: boolean;
  // Whether a data off → on (`wwan.autoconnect` Never → Always) clears
  // `ignoreConnect`, like the real router's fresh data session did. A test sets
  // this to false to model a stuck router the soft reset does not fix.
  dataToggleClearsStuck: boolean;
  // The `general.shutdown` values the router accepts. The web UI's Restart
  // button sends `restart`; `Restart` is refused by default so the client's
  // fallback isn't exercised unless a test allows it. Empty = refuses both.
  acceptedShutdownValues: string[];
  requests: FakeRequest[]; // every POST, in order
}

export interface FakeRouterDelays {
  connectMs: number; // Connecting → Connected
  disconnectMs: number; // Disconnecting → Disconnected
  rebootMs: number; // unreachable window after a reboot
}

export interface FakeRouterOptions {
  port?: number; // default: a random free port
  host?: string; // default 127.0.0.1
  password: string; // Admin password
  simPin?: string; // default "1234"
  delays?: Partial<FakeRouterDelays>;
}

export interface FakeRouter {
  url: string;
  state: FakeRouterState;
  // Forces a connection state and, for a transitional one, schedules its
  // natural follow-up like the real router would.
  setConnection(connection: FakeConnection): void;
  // The next request to `path` fails: a POST gets the error redirect, a GET
  // loses its connection.
  failNext(path: string): void;
  close(): Promise<void>;
}

const DEFAULT_DELAYS: FakeRouterDelays = {
  connectMs: 2000,
  disconnectMs: 1000,
  rebootMs: 8000,
};

const CONNECTION_TEXT: Record<FakeConnection, string> = {
  Connected: "4G+",
  Disconnected: "Disconnected",
  Connecting: "Connecting",
  Disconnecting: "Disconnecting",
};

const AUTOCONNECT = new Set(["Never", "Always", "HomeNetwork", "RoamNetwork"]);
const AUTH_TYPES = new Set(["None", "PAP", "CHAP", "PAPCHAP"]);
const IP_TYPES = new Set(["IPV4", "IPV6", "IPV4V6"]);
const ROAMING_TYPES = new Set(["None", ...IP_TYPES]);

const WRITE_DENY = 2;
const DELETE_DENY = 4;

// The real /error.json body — not even valid JSON.
const ERROR_BODY = '{ "errno": , "errdetail": "" }\n';
// What a refused restart answers: errno 1 / errdetail general.shutdown (the
// real router, 2026-10-03 and 2026-10-04, for `Restart`).
const SHUTDOWN_REJECTED_QUERY = "?errno=1&errdetail=general.shutdown";
const SUCCESS_BODY = '{ "success": true }\n';
const SESSION_COOKIE = "fakesession";

interface Session {
  role: "Guest" | "Admin";
  token: string;
}

function loadBaseModel(): RouterModel {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures/model-admin.fixture.json"), "utf8"),
  ) as RouterModel;
}

function profilesFrom(model: RouterModel): FakeProfile[] {
  return (model.wwan.profileList ?? [])
    .filter((p) => p.id)
    .map((p) => ({
      index: p.index ?? 0,
      id: p.id ?? "",
      name: p.name ?? "",
      apn: p.apn ?? "",
      username: p.username ?? "",
      // The fixture masks secrets as "****"; the fake keeps something real.
      password: p.password ? "fake-profile-secret" : "",
      authtype: p.authtype ?? "None",
      type: p.type ?? "IPV4V6",
      pdproamingtype: p.pdproamingtype ?? p.type ?? "IPV4V6",
      accessControl: Number(p.access_control) || 0,
    }));
}

function profileToModel(p: FakeProfile): RouterModelProfile {
  return {
    index: p.index,
    id: p.id,
    name: p.name,
    apn: p.apn,
    username: p.username,
    password: p.password,
    authtype: p.authtype,
    ipaddr: "0.0.0.0",
    type: p.type,
    pdproamingtype: p.pdproamingtype,
    access_control: p.accessControl === 0 ? "" : p.accessControl,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function cookieOf(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value;
  }
  return undefined;
}

function redirect(res: ServerResponse, location: string, cookie?: string) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  if (cookie)
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${cookie}; Path=/`);
  res.end();
}

function text(res: ServerResponse, body: string, contentType = "text/plain") {
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

export async function startFakeRouter(
  opts: FakeRouterOptions,
): Promise<FakeRouter> {
  const delays = { ...DEFAULT_DELAYS, ...opts.delays };
  const base = loadBaseModel();
  const sessions = new Map<string, Session>();
  const timers = new Set<NodeJS.Timeout>();
  const pendingFailures = new Map<string, number>();

  const state: FakeRouterState = {
    connection: base.wwan.connection as FakeConnection,
    simStatus: base.sim.status as FakeRouterState["simStatus"],
    simPin: opts.simPin ?? "1234",
    simPinEnabled: base.sim.pin.mode === "Enabled",
    simPinRetry: base.sim.pin.retry,
    autoconnect: base.wwan.autoconnect ?? "Always",
    roamingNow: !!base.wwan.roaming,
    serviceType: base.wwan.currentNWserviceType ?? "",
    operator: base.wwan.registerNetworkDisplay,
    activeProfileId: base.wwan.profile?.default ?? "",
    profiles: profilesFrom(base),
    rebootingUntil: 0,
    battChargeLevel: base.power.battChargeLevel,
    charging: base.power.charging,
    ignoreConnect: false,
    dataToggleClearsStuck: true,
    acceptedShutdownValues: ["restart"],
    requests: [],
  };

  let transition: NodeJS.Timeout | null = null;
  // The router's uptime counts from its last boot — a reboot resets it, which
  // is how the watchdog tells "restarted" from "still the old session".
  let bootedAt = Date.now() - (base.general?.upTime ?? 0) * 1000;

  function later(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  }

  function setConnection(connection: FakeConnection): void {
    if (transition) {
      clearTimeout(transition);
      timers.delete(transition);
      transition = null;
    }
    state.connection = connection;
    if (connection === "Connecting") {
      transition = later(delays.connectMs, () => {
        state.connection = "Connected";
      });
    } else if (connection === "Disconnecting") {
      transition = later(delays.disconnectMs, () => {
        state.connection = "Disconnected";
      });
    }
  }

  // After an unlock or boot the router connects on its own.
  function autoConnect(): void {
    if (state.simStatus === "Ready" && state.autoconnect !== "Never") {
      setConnection("Connecting");
    }
  }

  function buildModel(session: Session): RouterModel {
    const model = JSON.parse(JSON.stringify(base)) as RouterModel;
    const admin = session.role === "Admin";
    model.session = { userRole: session.role, secToken: session.token };
    model.general = {
      ...model.general,
      upTime: Math.max(0, Math.floor((Date.now() - bootedAt) / 1000)),
    };
    model.wwan.connection = state.connection;
    model.wwan.connectionText = CONNECTION_TEXT[state.connection];
    model.wwan.roaming = state.roamingNow;
    model.wwan.currentNWserviceType = state.serviceType;
    model.wwan.registerNetworkDisplay = state.operator;
    model.wwan.autoconnect = state.autoconnect;
    model.power.battChargeLevel = state.battChargeLevel;
    model.power.charging = state.charging;
    model.sim.status = state.simStatus;
    model.sim.pin.mode = state.simPinEnabled ? "Enabled" : "Disabled";
    model.sim.pin.retry = state.simPinRetry;
    if (state.simStatus !== "Ready") delete model.sim.iccid; // hidden while locked
    if (admin) {
      model.wwan.profile = { default: state.activeProfileId };
      model.wwan.profileList = [...state.profiles.map(profileToModel), {}];
      model.wifi = { SSID: "FakeWifi", passPhrase: "fake-wifi-passphrase" };
    } else {
      delete model.wwan.profile;
      delete model.wwan.profileList;
      delete model.sms;
      model.wifi = { SSID: "", passPhrase: "" };
    }
    return model;
  }

  // `Never` drops the data session (Disconnecting → Disconnected); setting it
  // back to anything else while Disconnected redials, like the real router
  // (measured live 2026-10-04: ~4s each way). A completed off → on is the soft
  // reset that clears the stuck flag, unless a test turned that off.
  function applyAutoconnect(value: string): void {
    const wasNever = state.autoconnect === "Never";
    state.autoconnect = value;
    if (value === "Never") {
      if (
        state.connection === "Connected" ||
        state.connection === "Connecting"
      ) {
        setConnection("Disconnecting");
      }
      return;
    }
    if (!wasNever) return;
    if (state.dataToggleClearsStuck) state.ignoreConnect = false;
    if (state.connection === "Disconnected" && !state.ignoreConnect) {
      autoConnect();
    }
  }

  function handleConfig(f: Record<string, string>): boolean {
    if ("wwan.connect" in f) {
      if (f["wwan.connect"] === "0") {
        if (state.connection !== "Connected") return false;
        setConnection("Disconnecting");
        return true;
      }
      if (state.simStatus !== "Ready" || state.connection !== "Disconnected") {
        return false;
      }
      if (!state.ignoreConnect) setConnection("Connecting");
      return true;
    }
    if ("wwan.autoconnect" in f) {
      if (!AUTOCONNECT.has(f["wwan.autoconnect"])) return false;
      applyAutoconnect(f["wwan.autoconnect"]);
      return true;
    }
    if ("wwan.profile.default" in f) {
      if (!state.profiles.some((p) => p.id === f["wwan.profile.default"])) {
        return false;
      }
      state.activeProfileId = f["wwan.profile.default"];
      return true;
    }
    if ("general.shutdown" in f) {
      reboot();
      return true;
    }
    if ("sim.pin.entry" in f) {
      if (state.simStatus !== "Locked") return false;
      if (f["sim.pin.entry"] === state.simPin) {
        state.simStatus = "Ready";
        state.simPinRetry = 3;
        autoConnect();
        return true;
      }
      state.simPinRetry = Math.max(0, state.simPinRetry - 1);
      if (state.simPinRetry === 0) state.simStatus = "Blocked";
      return true;
    }
    return false;
  }

  function reboot(): void {
    state.rebootingUntil = Date.now() + delays.rebootMs;
    bootedAt = state.rebootingUntil;
    sessions.clear();
    if (transition) {
      clearTimeout(transition);
      timers.delete(transition);
      transition = null;
    }
    state.connection = "Disconnected";
    state.ignoreConnect = false;
    state.simStatus = state.simPinEnabled ? "Locked" : "Ready";
    state.simPinRetry = 3;
    later(delays.rebootMs, autoConnect);
  }

  function handleProfile(f: Record<string, string>): boolean {
    const find = () => state.profiles.find((p) => p.id === f["profile.id"]);
    switch (f.action) {
      case "create": {
        if (!f["profile.name"] || !f["profile.apn"]) return false;
        if (!validEnums(f)) return false;
        const index =
          state.profiles.reduce((max, p) => Math.max(max, p.index), -1) + 1;
        state.profiles.push({
          index,
          id: `${f["profile.name"]} ${index}`,
          name: f["profile.name"],
          apn: f["profile.apn"],
          username: f["profile.username"] ?? "",
          password: f["profile.password"] ?? "",
          authtype: f["profile.authtype"],
          type: f["profile.type"],
          pdproamingtype: f["profile.pdproamingtype"],
          accessControl: 0,
        });
        return true;
      }
      case "update": {
        const profile = find();
        if (!profile || profile.accessControl & WRITE_DENY) return false;
        if (!f["profile.name"] || !f["profile.apn"]) return false;
        if (!validEnums(f)) return false;
        profile.name = f["profile.name"];
        profile.apn = f["profile.apn"];
        profile.username = f["profile.username"] ?? "";
        profile.authtype = f["profile.authtype"];
        profile.type = f["profile.type"];
        profile.pdproamingtype = f["profile.pdproamingtype"];
        if ("profile.password" in f) profile.password = f["profile.password"];
        return true;
      }
      case "delete": {
        const profile = find();
        if (!profile || profile.id === state.activeProfileId) return false;
        if (profile.accessControl & DELETE_DENY) return false;
        state.profiles = state.profiles.filter((p) => p !== profile);
        return true;
      }
      default:
        return false;
    }
  }

  function validEnums(f: Record<string, string>): boolean {
    return (
      AUTH_TYPES.has(f["profile.authtype"]) &&
      IP_TYPES.has(f["profile.type"]) &&
      ROAMING_TYPES.has(f["profile.pdproamingtype"])
    );
  }

  function handlePost(
    path: string,
    f: Record<string, string>,
    session: Session,
    res: ServerResponse,
  ): void {
    const reject = () => redirect(res, f.err_redirect || "/error.json");
    if (f.token !== session.token) return reject();

    if ("session.password" in f) {
      if (f["session.password"] !== opts.password) return reject();
      // Like the real M2 (verified live 2026-10-04): a password POST is a
      // toggle — on an already-Admin session it logs out to Guest.
      session.role = session.role === "Admin" ? "Guest" : "Admin";
      res.statusCode = 204;
      res.end();
      return;
    }

    if (session.role !== "Admin") return reject();
    if (
      path === "/Forms/config" &&
      "general.shutdown" in f &&
      !state.acceptedShutdownValues.includes(f["general.shutdown"])
    ) {
      return redirect(
        res,
        `${f.err_redirect || "/error.json"}${SHUTDOWN_REJECTED_QUERY}`,
      );
    }
    const accepted =
      path === "/Forms/config"
        ? handleConfig(f)
        : path === "/Forms/profile"
          ? handleProfile(f)
          : false; // /Forms/pinChange and anything else is not faked
    if (!accepted) return reject();
    redirect(res, f.ok_redirect || "/success.json");
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    // The reboot POST's own redirect target is still served — the real
    // router answers it before going down, and curl follows it.
    if (Date.now() < state.rebootingUntil && path !== "/success.json") {
      req.socket.destroy();
      return;
    }
    // Read the body before answering so a failure never resets a request
    // mid-upload.
    const body = method === "POST" ? await readBody(req) : "";
    const fields: Record<string, string> =
      method === "POST" ? Object.fromEntries(new URLSearchParams(body)) : {};
    if (method === "POST") state.requests.push({ method, path, fields });

    const failures = pendingFailures.get(path) ?? 0;
    if (failures > 0) {
      pendingFailures.set(path, failures - 1);
      if (method === "POST") return redirect(res, "/error.json");
      req.socket.destroy();
      return;
    }

    const cookie = cookieOf(req);
    const session = cookie ? sessions.get(cookie) : undefined;

    if (method === "GET" && path === "/api/model.json") {
      if (!session) {
        const id = randomBytes(8).toString("hex");
        sessions.set(id, {
          role: "Guest",
          token: `fake-sec-token-${randomBytes(4).toString("hex")}`,
        });
        return redirect(res, "/sess_cd_tmp?url=%2Fapi%2Fmodel.json", id);
      }
      return text(res, JSON.stringify(buildModel(session)), "application/json");
    }
    if (method === "GET" && path === "/sess_cd_tmp") {
      return redirect(res, "/api/model.json");
    }
    if (method === "GET" && path === "/success.json") {
      return text(res, SUCCESS_BODY, "application/json");
    }
    if (method === "GET" && path === "/error.json") {
      const errno = url.searchParams.get("errno");
      const body =
        errno === null
          ? ERROR_BODY
          : `{ "errno": ${Number(errno)}, "errdetail": ${JSON.stringify(url.searchParams.get("errdetail") ?? "")} }\n`;
      return text(res, body, "application/json");
    }
    if (method === "POST" && path.startsWith("/Forms/")) {
      if (!session) return redirect(res, "/error.json");
      return handlePost(path, fields, session, res);
    }
    res.statusCode = 404;
    res.end();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve),
  );
  const { address, port } = server.address() as AddressInfo;

  return {
    url: `http://${address}:${port}`,
    state,
    setConnection,
    failNext(path) {
      pendingFailures.set(path, (pendingFailures.get(path) ?? 0) + 1);
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
