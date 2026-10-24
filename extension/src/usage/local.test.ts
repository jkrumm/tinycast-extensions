import { describe, expect, it } from "vitest";
import { loadLocalRouting } from "./local";
import { LANES } from "./routing";

const NOW = 1_792_880_000;
const usage = JSON.stringify({
  accounts: [
    {
      id: "iu",
      enabled: true,
      five_hour: 2,
      seven_day: 89,
      age_s: 5,
      auth_ok: true,
    },
  ],
});

describe("loadLocalRouting", () => {
  it("asks for usage and a dry, non-refreshing pick per lane", async () => {
    const calls: string[][] = [];
    const out = await loadLocalRouting(async (args) => {
      calls.push(args);
      return args[0] === "usage"
        ? usage
        : `unset CLAUDE_CONFIG_DIR\n# picked=iu reason=home stale=false\n`;
    }, NOW);
    expect(out?.accounts?.[0].id).toBe("iu");
    expect(out?.picks).toHaveLength(LANES.length);
    const picks = calls.filter((c) => c[0] === "pick");
    expect(picks.every((c) => c.includes("--dry") && c.includes("--why"))).toBe(
      true,
    );
  });

  it("survives a failing lane", async () => {
    const out = await loadLocalRouting(async (args) => {
      if (args[0] === "usage") return usage;
      if (args[2] === "wave") throw new Error("boom");
      return "# picked=iu reason=home stale=false";
    }, NOW);
    expect(out?.picks).toHaveLength(LANES.length - 1);
  });

  it("is null when the CLI is unavailable", async () => {
    expect(
      await loadLocalRouting(async () => {
        throw new Error("ENOENT");
      }, NOW),
    ).toBeNull();
  });
});
