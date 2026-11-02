import { describe, expect, it, vi } from "vitest";
import { Hud, runNamiPresence, runScene } from "./actions";

describe("runScene", () => {
  it("triggers by target and says the scene name", async () => {
    const run = vi.fn(async () => "");
    const hud = vi.fn<Hud>(async () => undefined);
    await runScene("Chill", hud, run, "A1");
    expect(run).toHaveBeenCalledWith(["trigger", "A1"]);
    expect(hud).toHaveBeenCalledWith("Chill triggered");
  });

  it("triggers by name by default", async () => {
    const run = vi.fn(async () => "");
    await runScene("Arbeit", vi.fn(), run);
    expect(run).toHaveBeenCalledWith(["trigger", "Arbeit"]);
  });

  it("shows the friendly error on failure", async () => {
    const hud = vi.fn<Hud>(async () => undefined);
    await runScene("Arbeit", hud, async () => {
      throw new Error("home: HomeClaw unreachable");
    });
    expect(hud).toHaveBeenCalledTimes(1);
    expect(hud.mock.calls[0][0]).toMatch(
      /^Could not trigger Arbeit: .*mini online/,
    );
  });
});

describe("runNamiPresence", () => {
  it("sets the switch and confirms", async () => {
    const run = vi.fn(async () => "");
    const hud = vi.fn<Hud>(async () => undefined);
    await runNamiPresence(false, hud, run);
    expect(run).toHaveBeenCalledWith([
      "set",
      "Nami zu Hause",
      "power",
      "false",
    ]);
    expect(hud).toHaveBeenCalledWith("Nami comes along");
  });

  it("reports a failure", async () => {
    const hud = vi.fn<Hud>(async () => undefined);
    await runNamiPresence(true, hud, async () => {
      throw new Error("timed out");
    });
    expect(hud.mock.calls[0][0]).toMatch(/^Could not update Nami: /);
  });

  it("does not blame the command when only the HUD fails", async () => {
    const hud = vi.fn<Hud>(async () => {
      throw new Error("hud broke");
    });
    await expect(runNamiPresence(true, hud, async () => "")).rejects.toThrow(
      "hud broke",
    );
    expect(hud).toHaveBeenCalledTimes(1);
  });
});
