import { describe, expect, it, vi } from "vitest";
import { actionArgs, perform, runSpotify } from "./actions";

const state = (extra = {}) =>
  JSON.stringify({
    status: "playing",
    track: "Charmed",
    artists: ["Σtella"],
    volume: 50,
    ...extra,
  });

describe("actionArgs", () => {
  it("maps actions to home audio arguments", () => {
    expect(actionArgs("toggle")).toEqual(["toggle"]);
    expect(actionArgs("previous")).toEqual(["prev"]);
    expect(actionArgs("louder")).toEqual(["volume", "+10"]);
    expect(actionArgs("quieter")).toEqual(["volume", "-10"]);
    expect(actionArgs("muchQuieter")).toEqual(["volume", "-30"]);
    expect(actionArgs("take")).toEqual(["take"]);
    expect(actionArgs({ volume: "40" })).toEqual(["volume", "40"]);
  });
});

describe("runSpotify", () => {
  it("runs the CLI and reports the state as a HUD line", async () => {
    const run = vi.fn(async () => state());
    const hud = vi.fn<(message: string) => Promise<void>>(
      async () => undefined,
    );
    const got = await runSpotify("toggle", hud, run);
    expect(run).toHaveBeenCalledWith(["audio", "toggle"]);
    expect(hud).toHaveBeenCalledWith("▶ Charmed — Σtella · 50 %");
    expect(got?.track).toBe("Charmed");
  });

  it("reports a failure on one line and resolves null", async () => {
    const run = vi.fn(async () => {
      throw new Error("HomeClaw unreachable\nmore");
    });
    const hud = vi.fn<(message: string) => Promise<void>>(
      async () => undefined,
    );
    expect(await runSpotify("next", hud, run)).toBeNull();
    expect(hud.mock.calls[0][0]).toMatch(/^Spotify: /);
    expect(hud.mock.calls[0][0]).not.toContain("\n");
  });

  it("treats unreadable output as a failure", async () => {
    const hud = vi.fn<(message: string) => Promise<void>>(
      async () => undefined,
    );
    expect(await runSpotify("next", hud, async () => "garbage")).toBeNull();
    expect(hud.mock.calls[0][0]).toContain("unreadable");
  });
});

describe("play on MacBook", () => {
  it("releases Mine, then asks the local Spotify to play", async () => {
    const calls: string[] = [];
    const run = async (args: string[]) => {
      calls.push(args.join(" "));
      return state({ status: "paused", active: false });
    };
    const osascript = vi.fn(async (script: string) => {
      calls.push(script);
    });
    const hud = vi.fn<(message: string) => Promise<void>>(
      async () => undefined,
    );
    await runSpotify("macbook", hud, run, osascript);
    expect(calls).toEqual([
      "audio release",
      'tell application "Spotify" to play',
    ]);
    expect(hud).toHaveBeenCalledWith("Playing on MacBook");
  });

  it("names the half that worked when osascript fails", async () => {
    const hud = vi.fn<(message: string) => Promise<void>>(
      async () => undefined,
    );
    const osascript = async () => {
      throw new Error("not authorized");
    };
    await runSpotify("macbook", hud, async () => state(), osascript);
    expect(hud.mock.calls[0][0]).toContain("Mine released");
    expect(hud.mock.calls[0][0]).toContain("not authorized");
  });

  it("does not touch Spotify when the release fails", async () => {
    const osascript = vi.fn<(message: string) => Promise<void>>(
      async () => undefined,
    );
    await expect(
      perform(
        "macbook",
        async () => {
          throw new Error("down");
        },
        osascript,
      ),
    ).rejects.toThrow("down");
    expect(osascript).not.toHaveBeenCalled();
  });
});
