// The WalkingPad host's HTTP API (walkingpad-mac docs/protocol.md §8) behind
// one injected transport, so the action core runs against golden fixtures with
// no network. Only the four calls the commands need.

import { parseStatus } from "./parse";
import { PadStatus, WalkingPadErrorKind } from "./types";

// A read answers in well under a second; POST /start blocks 4–5 s while the
// host waits out the belt's 3-2-1 ramp, so a command gets a generous timeout
// (the Swift client uses 20 s).
export const READ_TIMEOUT_MS = 5_000;
export const COMMAND_TIMEOUT_MS = 20_000;

export class WalkingPadError extends Error {
  constructor(
    readonly kind: WalkingPadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "WalkingPadError";
  }
}

export interface HttpReply {
  status: number;
  body: string;
}

// Port: rejects with a WalkingPadError of kind "timeout" or "unreachable".
export interface Transport {
  request(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    timeoutMs: number;
  }): Promise<HttpReply>;
}

const hostMessage = (body: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const { error } = parsed as { error: unknown };
      if (typeof error === "string" && error) return error;
    }
  } catch {
    // not JSON: no host message
  }
  return null;
};

function checked(reply: HttpReply): HttpReply {
  if (reply.status >= 200 && reply.status < 300) return reply;
  if (reply.status === 401) {
    throw new WalkingPadError("unauthorized", "The host refused the token");
  }
  const detail = hostMessage(reply.body);
  throw new WalkingPadError(
    "http",
    detail ? `HTTP ${reply.status}: ${detail}` : `HTTP ${reply.status}`,
  );
}

export interface PadClient {
  status(): Promise<PadStatus>;
  start(speedKmh: number): Promise<void>;
  stop(): Promise<void>;
  setSpeed(speedKmh: number): Promise<void>;
}

export function createClient(transport: Transport): PadClient {
  const post = async (path: string, body?: unknown): Promise<void> => {
    checked(
      await transport.request({
        method: "POST",
        path,
        body,
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    );
  };
  return {
    async status() {
      const reply = checked(
        await transport.request({
          method: "GET",
          path: "/status",
          timeoutMs: READ_TIMEOUT_MS,
        }),
      );
      const status = parseStatus(reply.body);
      if (!status) {
        throw new WalkingPadError(
          "unreadable",
          "The host sent no readable status",
        );
      }
      return status;
    },
    start: (speedKmh) => post("/start", { speed_kmh: speedKmh }),
    stop: () => post("/stop"),
    setSpeed: (speedKmh) => post("/speed", { speed_kmh: speedKmh }),
  };
}

// One line for a HUD or toast; never carries the host URL or the token.
export function describeError(error: unknown): string {
  if (error instanceof WalkingPadError) {
    switch (error.kind) {
      case "unconfigured":
        return error.message;
      case "unauthorized":
        return "Token refused — check it in the WalkingPad app";
      case "timeout":
        return "Timed out";
      case "unreachable":
        return "Host unreachable";
      case "http":
      case "unreadable":
        return error.message;
    }
  }
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}
