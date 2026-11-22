import { describe, expect, it } from "vitest";
import {
  COMMAND_TIMEOUT_MS,
  HttpReply,
  READ_TIMEOUT_MS,
  Transport,
  WalkingPadError,
  createClient,
  describeError,
} from "./client";
import { fixture } from "./fixtures";

type Sent = { method: string; path: string; body?: unknown; timeoutMs: number };

function transport(reply: HttpReply | Error) {
  const sent: Sent[] = [];
  const t: Transport = {
    async request(input) {
      sent.push(input);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { client: createClient(t), sent };
}

describe("client", () => {
  it("reads /status within the read timeout", async () => {
    const { client, sent } = transport({
      status: 200,
      body: fixture("status-active"),
    });
    const status = await client.status();
    expect(status.speedKmh).toBe(4.5);
    expect(sent).toEqual([
      { method: "GET", path: "/status", timeoutMs: READ_TIMEOUT_MS },
    ]);
  });

  it("gives commands at least 15 s: POST /start blocks 4-5 s", async () => {
    expect(COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    const { client, sent } = transport({ status: 200, body: fixture("ok") });
    await client.start(3.5);
    await client.stop();
    await client.setSpeed(4);
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/start",
        body: { speed_kmh: 3.5 },
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
      { method: "POST", path: "/stop", timeoutMs: COMMAND_TIMEOUT_MS },
      {
        method: "POST",
        path: "/speed",
        body: { speed_kmh: 4 },
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
    ]);
  });

  it("maps 401 to unauthorized", async () => {
    const { client } = transport({ status: 401, body: "" });
    await expect(client.status()).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("carries the host's error text on other failures", async () => {
    const { client } = transport({
      status: 503,
      body: fixture("error-unavailable"),
    });
    await expect(client.stop()).rejects.toMatchObject({
      kind: "http",
      message: "HTTP 503: ble controller not connected",
    });
  });

  it("rejects a status body it cannot read", async () => {
    const { client } = transport({ status: 200, body: fixture("ok") });
    await expect(client.status()).rejects.toMatchObject({ kind: "unreadable" });
  });

  it("passes a transport timeout through", async () => {
    const { client } = transport(new WalkingPadError("timeout", "Timed out"));
    await expect(client.start(3)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("describeError", () => {
  it("is one line per kind and carries no URL", () => {
    expect(describeError(new WalkingPadError("timeout", "x"))).toBe(
      "Timed out",
    );
    expect(describeError(new WalkingPadError("unreachable", "x"))).toBe(
      "Host unreachable",
    );
    expect(describeError(new Error("first\nsecond"))).toBe("first");
  });
});
