import { describe, expect, it } from "vitest";
import {
  HEALTH_MAX_AGE_MS,
  HealthRow,
  groupByMachine,
  healthMarkdown,
  healthTitle,
  isHealthFresh,
  parseFixCommand,
  parseHealth,
  parseStampedHealth,
  rowTitle,
  worstState,
} from "./health";

const row = (over: Partial<HealthRow>): HealthRow => ({
  machine: "mini",
  id: "iu",
  check: "login",
  state: "ok",
  detail: "26.4 d left",
  fix: null,
  ...over,
});

const iuWarn = row({
  state: "warn",
  detail: "login ends in 6.6 d",
  fix: "claude-relogin iu --machine mini",
});
const meFail = row({
  machine: "macbook",
  id: "me",
  check: "quota",
  state: "fail",
  detail: "no quota sample for 34 h (token rejected?)",
  fix: "claude-relogin me --machine macbook",
});
const reach = row({
  id: "-",
  check: "reach",
  state: "warn",
  detail: "ssh timed out",
});

describe("parseHealth", () => {
  it("parses rows and recomputes the worst state", () => {
    const out = parseHealth(
      JSON.stringify({ state: "ok", rows: [row({}), iuWarn] }),
    );
    expect(out?.state).toBe("warn");
    expect(out?.rows).toHaveLength(2);
    expect(out?.rows[1].fix).toBe("claude-relogin iu --machine mini");
  });

  it("drops malformed rows and keeps the valid ones", () => {
    const out = parseHealth(
      JSON.stringify({
        rows: [iuWarn, { machine: "nas", id: "x", check: "login" }, 7],
      }),
    );
    expect(out?.rows).toEqual([iuWarn]);
  });

  it("returns null for non-JSON, a missing rows array, or only bad rows", () => {
    expect(parseHealth("boom")).toBeNull();
    expect(parseHealth("{}")).toBeNull();
    expect(parseHealth(JSON.stringify({ rows: [{ nope: 1 }] }))).toBeNull();
  });

  it("accepts an empty report as healthy", () => {
    expect(parseHealth('{"state":"ok","rows":[]}')).toEqual({
      state: "ok",
      rows: [],
    });
  });

  it("treats an empty fix as none", () => {
    expect(
      parseHealth(JSON.stringify({ rows: [row({ fix: "" })] }))?.rows[0].fix,
    ).toBeNull();
  });
});

describe("worstState / healthTitle", () => {
  it("fail beats warn beats ok", () => {
    expect(worstState([])).toBe("ok");
    expect(worstState([row({}), iuWarn])).toBe("warn");
    expect(worstState([iuWarn, meFail])).toBe("fail");
  });

  it("titles the worst row and counts the rest", () => {
    expect(healthTitle({ state: "warn", rows: [row({}), iuWarn] })).toBe(
      "iu login ends in 6.6 d on mini",
    );
    expect(healthTitle({ state: "fail", rows: [iuWarn, meFail] })).toBe(
      "me no quota sample for 34 h (token rejected?) on macbook (+1 more)",
    );
    expect(healthTitle({ state: "ok", rows: [row({})] })).toBe(
      "All sessions healthy",
    );
  });

  it("titles a machine-level row without an account", () => {
    expect(rowTitle(reach)).toBe("mini reach: ssh timed out");
  });
});

describe("groupByMachine", () => {
  it("groups rows per machine, mini first, skipping empty machines", () => {
    const groups = groupByMachine([meFail, iuWarn, reach]);
    expect(groups.map((g) => g.machine)).toEqual(["mini", "macbook"]);
    expect(groups[0].rows).toEqual([iuWarn, reach]);
    expect(groupByMachine([meFail]).map((g) => g.machine)).toEqual(["macbook"]);
  });
});

describe("parseFixCommand", () => {
  it("splits an allowed relogin into argv", () => {
    expect(parseFixCommand("claude-relogin iu --machine mini")).toEqual([
      "iu",
      "--machine",
      "mini",
    ]);
    expect(parseFixCommand("claude-relogin me")).toEqual(["me"]);
    expect(parseFixCommand("claude-relogin acct-2 --machine macbook")).toEqual([
      "acct-2",
      "--machine",
      "macbook",
    ]);
  });

  it.each([
    ["no fix", null],
    ["another command", "rm -rf /"],
    ["no id", "claude-relogin "],
    ["no id, flag only", "claude-relogin --machine mini"],
    ["a shell separator", "claude-relogin iu; rm -rf ~"],
    ["a command substitution", "claude-relogin $(whoami)"],
    ["a pipe", "claude-relogin iu | sh"],
    ["an uppercase id", "claude-relogin IU"],
    ["an unknown machine", "claude-relogin iu --machine nas"],
    ["another flag", "claude-relogin iu --visible"],
    ["a second flag", "claude-relogin iu --machine mini --ask"],
    ["a leading path", "/bin/claude-relogin iu"],
    ["a prefix before it", "sudo claude-relogin iu"],
    ["a newline", "claude-relogin iu\nrm -rf ~"],
    ["a double space", "claude-relogin  iu"],
  ])("rejects %s", (_, fix) => {
    expect(parseFixCommand(fix)).toBeNull();
  });
});

describe("cache helpers", () => {
  const report = { state: "warn" as const, rows: [iuWarn] };

  it("treats a reading as fresh for 5 minutes", () => {
    const stamped = { report, fetchedAt: 1_000 };
    expect(isHealthFresh(stamped, 1_000 + HEALTH_MAX_AGE_MS - 1)).toBe(true);
    expect(isHealthFresh(stamped, 1_000 + HEALTH_MAX_AGE_MS)).toBe(false);
    expect(isHealthFresh(null, 1_000)).toBe(false);
  });

  it("round-trips a persisted reading and rejects junk", () => {
    const raw = JSON.stringify({ report, fetchedAt: 42 });
    expect(parseStampedHealth(raw)).toEqual({ report, fetchedAt: 42 });
    expect(parseStampedHealth("nope")).toBeNull();
    expect(parseStampedHealth(JSON.stringify({ report }))).toBeNull();
    expect(
      parseStampedHealth(JSON.stringify({ report: {}, fetchedAt: 1 })),
    ).toBeNull();
  });
});

describe("healthMarkdown", () => {
  it("renders one table per machine", () => {
    const md = healthMarkdown({
      state: "fail",
      rows: [iuWarn, row({ id: "me" }), meFail],
    }).join("\n");
    expect(md).toContain("## Sessions");
    expect(md).toContain("**mini**");
    expect(md).toContain("**macbook**");
    expect(md).toContain("| 🟠 iu | login | login ends in 6.6 d |");
  });
});
