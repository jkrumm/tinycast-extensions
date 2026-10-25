import { describe, expect, it } from "vitest";
import { lanesTable, missingSideNote, routingMarkdown } from "./routing-text";
import { LANES, LanePick } from "./routing";

const all = (picked: string, reason = "home", stale = false): LanePick[] =>
  LANES.map((lane) => ({ lane, picked, reason, stale }));

describe("lanesTable", () => {
  it("is this Mac only without the mini's picks", () => {
    const t = lanesTable({ picks: all("me"), argoPicks: null });
    expect(t[0]).toBe("| Work | Goes to | Why |");
    expect(t).toHaveLength(3);
  });

  it("puts both machines side by side and marks the lanes that differ", () => {
    const mini = all("me").map((p) =>
      p.lane === "headless" ? { ...p, picked: "iu" } : p,
    );
    const t = lanesTable({ picks: all("me"), argoPicks: mini });
    expect(t[0]).toBe("| Work | This Mac | Mini |");
    expect(t[2]).toContain("Interactive, Waves");
    expect(t[2]).not.toContain("⚠");
    expect(t[3]).toBe("| ⚠ Headless | me (home account) | iu (home account) |");
  });

  it("names a stale mini pick", () => {
    const t = lanesTable({
      picks: all("me"),
      argoPicks: all("me", "home", true),
    });
    expect(t[2]).toContain("me (home account) — stale sample");
  });
});

describe("missingSideNote", () => {
  const acc = [] as never[];
  it("says the mini sent no picks, only when everything else is present", () => {
    expect(
      missingSideNote({
        local: acc,
        argo: acc,
        picks: all("me"),
        argoPicks: null,
      }),
    ).toMatch(/eligibility only/);
    expect(
      missingSideNote({
        local: acc,
        argo: acc,
        picks: all("me"),
        argoPicks: all("me"),
      }),
    ).toBeNull();
  });
});

describe("routingMarkdown", () => {
  it("lists the diverging lanes in words", () => {
    const md = routingMarkdown(
      [],
      {
        local: [],
        argo: [],
        picks: all("me"),
        argoPicks: all("iu"),
      },
      0,
    ).join("\n");
    expect(md).toContain(": this Mac → me, mini → iu");
  });
});
