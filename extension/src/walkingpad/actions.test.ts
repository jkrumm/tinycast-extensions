import { describe, expect, it, vi } from "vitest";
import { Hud, perform, runWalkingPad } from "./actions";
import { PadClient, WalkingPadError } from "./client";
import { FixtureName, fixture, statusWith } from "./fixtures";
import { parseStatus } from "./parse";

// A client whose /status is one golden response; every belt call is recorded.
function fakeClient(raw: string) {
  const calls: string[] = [];
  const client: PadClient = {
    status: async () => {
      calls.push("status");
      const status = parseStatus(raw);
      if (!status) throw new Error("fixture does not parse");
      return status;
    },
    start: async (speed) => void calls.push(`start ${speed}`),
    stop: async () => void calls.push("stop"),
    setSpeed: async (speed) => void calls.push(`speed ${speed}`),
  };
  return { client, calls };
}

const run = async (
  action: Parameters<typeof perform>[0],
  raw: string,
  startSpeed?: number,
) => {
  const { client, calls } = fakeClient(raw);
  const outcome = await perform(action, client, startSpeed);
  return { outcome, calls };
};

describe("toggle", () => {
  it("starts a standing belt at the start speed", async () => {
    for (const name of ["status-standby", "status-stopped"] as FixtureName[]) {
      const { outcome, calls } = await run("toggle", fixture(name));
      expect(calls).toEqual(["status", "start 3"]);
      expect(outcome).toEqual({ message: "Started at 3.0 km/h", sent: true });
    }
  });

  it("uses the app's start speed when given", async () => {
    const { calls } = await run("toggle", fixture("status-standby"), 3.5);
    expect(calls).toEqual(["status", "start 3.5"]);
  });

  it("stops an active belt", async () => {
    const { outcome, calls } = await run("toggle", fixture("status-active"));
    expect(calls).toEqual(["status", "stop"]);
    expect(outcome.message).toBe("Stopped");
  });

  it("stops a belt that is still ramping", async () => {
    const { calls } = await run("toggle", fixture("status-starting"));
    expect(calls).toEqual(["status", "stop"]);
  });

  it("treats a belt state it cannot decode as standing", async () => {
    const { calls } = await run("toggle", fixture("status-unknown"));
    expect(calls).toEqual(["status", "start 3"]);
  });

  it("sends nothing while the belt stops or the pad is off", async () => {
    for (const name of [
      "status-stopping",
      "status-disconnected",
    ] as FixtureName[]) {
      const { outcome, calls } = await run("toggle", fixture(name));
      expect(calls).toEqual(["status"]);
      expect(outcome.sent).toBe(false);
    }
  });
});

describe("faster and slower", () => {
  it("steps 0.5 km/h from the fresh speed", async () => {
    const up = await run("faster", fixture("status-active")); // 4.5
    expect(up.calls).toEqual(["status", "speed 5"]);
    expect(up.outcome.message).toBe("Speed 5.0 km/h");
    const down = await run("slower", fixture("status-active"));
    expect(down.calls).toEqual(["status", "speed 4"]);
  });

  it("snaps an off-grid speed onto the grid", async () => {
    const raw = statusWith("status-active", { speed_kmh: 3.2 });
    expect((await run("faster", raw)).calls).toEqual(["status", "speed 3.5"]);
    expect((await run("slower", raw)).calls).toEqual(["status", "speed 3"]);
  });

  it("sends nothing past the top of the range", async () => {
    const raw = statusWith("status-active", { speed_kmh: 6.0 });
    const { outcome, calls } = await run("faster", raw);
    expect(calls).toEqual(["status"]);
    expect(outcome).toEqual({
      message: "Already at 6.0 km/h (max)",
      sent: false,
    });
    expect((await run("slower", raw)).calls).toEqual(["status", "speed 5.5"]);
  });

  it("sends nothing below the bottom of the range", async () => {
    const raw = statusWith("status-active", { speed_kmh: 0.5 });
    const { outcome, calls } = await run("slower", raw);
    expect(calls).toEqual(["status"]);
    expect(outcome.message).toBe("Already at 0.5 km/h (min)");
    expect((await run("faster", raw)).calls).toEqual(["status", "speed 1"]);
  });

  it("never sends /speed to a standing belt: the host would start it", async () => {
    for (const name of [
      "status-standby",
      "status-stopped",
      "status-starting",
      "status-stopping",
      "status-disconnected",
    ] as FixtureName[]) {
      for (const action of ["faster", "slower"] as const) {
        const { outcome, calls } = await run(action, fixture(name));
        expect(calls).toEqual(["status"]);
        expect(outcome.sent).toBe(false);
      }
    }
  });
});

describe("speed presets", () => {
  it("sets the speed while walking", async () => {
    const { outcome, calls } = await run(
      { speed: 4.0 },
      fixture("status-active"),
    );
    expect(calls).toEqual(["status", "speed 4"]);
    expect(outcome.message).toBe("Speed 4.0 km/h");
  });

  it("starts a standing belt at the preset instead of sending /speed", async () => {
    for (const name of ["status-standby", "status-stopped"] as FixtureName[]) {
      const { outcome, calls } = await run({ speed: 5.0 }, fixture(name));
      expect(calls).toEqual(["status", "start 5"]);
      expect(outcome.message).toBe("Started at 5.0 km/h");
    }
  });

  it("starts while the belt ramps (the host's /start is idempotent)", async () => {
    const { calls } = await run({ speed: 3.5 }, fixture("status-starting"));
    expect(calls).toEqual(["status", "start 3.5"]);
  });

  it("sends nothing while the belt stops or the pad is off", async () => {
    for (const name of [
      "status-stopping",
      "status-disconnected",
    ] as FixtureName[]) {
      expect((await run({ speed: 3.0 }, fixture(name))).calls).toEqual([
        "status",
      ]);
    }
  });

  it("clamps a speed outside the range", async () => {
    expect((await run({ speed: 9 }, fixture("status-active"))).calls).toEqual([
      "status",
      "speed 6",
    ]);
  });
});

describe("runWalkingPad", () => {
  const hud = () => vi.fn<Hud>(async () => undefined);

  it("reports the outcome as one HUD line", async () => {
    const h = hud();
    const { client } = fakeClient(fixture("status-active"));
    const outcome = await runWalkingPad("faster", h, client);
    expect(h).toHaveBeenCalledWith("Speed 5.0 km/h");
    expect(outcome?.sent).toBe(true);
  });

  it("names a refused token (401)", async () => {
    const h = hud();
    const client: PadClient = {
      ...fakeClient(fixture("status-active")).client,
      status: async () => {
        throw new WalkingPadError("unauthorized", "The host refused the token");
      },
    };
    expect(await runWalkingPad("toggle", h, client)).toBeNull();
    expect(h).toHaveBeenCalledWith(
      "WalkingPad: Token refused — check it in the WalkingPad app",
    );
  });

  it("names a timeout, also when the start call is the one that times out", async () => {
    const h = hud();
    const client: PadClient = {
      ...fakeClient(fixture("status-standby")).client,
      start: async () => {
        throw new WalkingPadError("timeout", "Timed out");
      },
    };
    expect(await runWalkingPad("toggle", h, client)).toBeNull();
    expect(h).toHaveBeenCalledWith("WalkingPad: Timed out");
  });

  it("reports an unreachable host on one line", async () => {
    const h = hud();
    const client: PadClient = {
      ...fakeClient(fixture("status-active")).client,
      status: async () => {
        throw new WalkingPadError("unreachable", "Host unreachable");
      },
    };
    await runWalkingPad("toggle", h, client);
    expect(h.mock.calls[0][0]).toBe("WalkingPad: Host unreachable");
  });
});
