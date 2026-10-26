import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  BAD_SCHEMA_TEXT,
  MISSING_TEXT,
  ageLine,
  budgetState,
  canSpendLine,
  freesLine,
  iuBudgetView,
  loadIuBudget,
  modelShare,
  parseIuBudget,
  tileFragment,
  titleMark,
  unavailableText,
  usageLine,
} from "./iu-budget";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const HOUR = 3_600_000;

function fixture(over: Partial<Record<string, unknown>> = {}) {
  return {
    schema: 1,
    fetched_at: new Date(NOW - HOUR).toISOString(),
    limit_usd: 500,
    window_days: 30,
    rolling30_usd: 250,
    can_spend_today_usd: 20,
    daily: [
      { day: "2026-10-25", usd: 10 },
      { day: "2026-10-26", usd: 12.5 },
    ],
    top_models: [{ label: "Deepseek V4.1 Flash", usd: 120 }],
    dropoff_next7: [
      { day: "2026-10-27", frees_usd: 8.2 },
      { day: "2026-10-28", frees_usd: 4 },
    ],
    ...over,
  };
}

function viewOf(over: Partial<Record<string, unknown>> = {}, nowMs = NOW) {
  const r = parseIuBudget(fixture(over));
  if (r.kind !== "ok") throw new Error(`fixture invalid: ${r.kind}`);
  return iuBudgetView(r.data, nowMs);
}

describe("parseIuBudget", () => {
  it("accepts the schema-1 contract", () => {
    const r = parseIuBudget(fixture());
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.data.rolling30Usd).toBe(250);
      expect(r.data.dropoffNext7[0]).toEqual({
        day: "2026-10-27",
        freesUsd: 8.2,
      });
    }
  });

  it("flags another schema as unknown format, never guesses", () => {
    const r = parseIuBudget(fixture({ schema: 2 }));
    expect(r.kind).toBe("bad-schema");
    expect(unavailableText(r)).toBe(BAD_SCHEMA_TEXT);
  });

  it.each([
    ["fetched_at", { fetched_at: "nope" }],
    ["limit_usd", { limit_usd: 0 }],
    ["rolling30_usd", { rolling30_usd: "5" }],
    ["daily", { daily: [{ day: "x" }] }],
    ["top_models", { top_models: null }],
    ["dropoff_next7", { dropoff_next7: [{ day: "x", frees_usd: "1" }] }],
  ])("rejects a malformed %s", (field, over) => {
    expect(parseIuBudget(fixture(over))).toEqual({
      kind: "invalid",
      reason: field,
    });
  });

  it("rejects a non-object", () => {
    expect(parseIuBudget([]).kind).toBe("invalid");
  });
});

describe("loadIuBudget", () => {
  it("reports a missing file with the login hint", async () => {
    const r = await loadIuBudget("/nonexistent/latest.json");
    expect(r.kind).toBe("missing");
    expect(unavailableText(r)).toBe(MISSING_TEXT);
  });

  it("reads a valid file and survives broken JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iu-budget-"));
    const good = join(dir, "good.json");
    const bad = join(dir, "bad.json");
    await writeFile(good, JSON.stringify(fixture()));
    await writeFile(bad, "{ nope");
    expect((await loadIuBudget(good)).kind).toBe("ok");
    expect(await loadIuBudget(bad)).toEqual({
      kind: "invalid",
      reason: "not JSON",
    });
  });
});

describe("state", () => {
  it.each([
    [0, "ok"],
    [79.9, "ok"],
    [80, "warn"],
    [100, "warn"],
    [100.1, "over"],
  ])("%s %% is %s", (pct, state) => {
    expect(budgetState(pct)).toBe(state);
  });

  it("derives percent from the file's own limit", () => {
    const v = viewOf({ rolling30_usd: 577.93 });
    expect(Math.round(v.percent)).toBe(116);
    expect(v.state).toBe("over");
    expect(usageLine(v)).toBe("$578 / $500 (116 %)");
  });
});

describe("freshness", () => {
  it("is fresh at 1 h, stale past 8 h, dead past 48 h", () => {
    expect(viewOf().freshness).toBe("fresh");
    const at = (h: number) => new Date(NOW - h * HOUR).toISOString();
    expect(viewOf({ fetched_at: at(9) }).freshness).toBe("stale");
    expect(viewOf({ fetched_at: at(49) }).freshness).toBe("dead");
  });

  it("words the age and the dead warning", () => {
    expect(ageLine(viewOf())).toBe("Updated 1h ago");
    const stale = viewOf({
      fetched_at: new Date(NOW - 9 * HOUR).toISOString(),
    });
    expect(ageLine(stale)).toBe("Updated 9h ago (stale)");
    const dead = viewOf({
      fetched_at: new Date(NOW - 72 * HOUR).toISOString(),
    });
    expect(ageLine(dead)).toContain("3d ago — portal session likely expired");
  });
});

describe("derived text", () => {
  it("sums what drops off over 7 days", () => {
    const v = viewOf();
    expect(v.freesNext7Usd).toBeCloseTo(12.2);
    expect(freesLine(v)).toBe("Frees $12 over the next 7 days");
    expect(freesLine(viewOf({ dropoff_next7: [] }))).toBeNull();
  });

  it("says how much is left, or how far over", () => {
    expect(canSpendLine(viewOf())).toBe("Can spend today: $20");
    expect(canSpendLine(viewOf({ can_spend_today_usd: -60.1 }))).toBe(
      "Over the cap by $60 — spend nothing today",
    );
  });

  it("marks the title only when the budget needs attention", () => {
    expect(titleMark(viewOf())).toBe("");
    expect(titleMark(viewOf({ rolling30_usd: 420 }))).toBe("IU 84%");
    expect(titleMark(viewOf({ rolling30_usd: 578 }))).toBe("IU 116%");
  });

  it("marks a stale number with ~ and a dead one with ?", () => {
    const at = (h: number) => new Date(NOW - h * HOUR).toISOString();
    expect(titleMark(viewOf({ rolling30_usd: 578, fetched_at: at(9) }))).toBe(
      "IU ~116%",
    );
    expect(titleMark(viewOf({ rolling30_usd: 578, fetched_at: at(72) }))).toBe(
      "IU ?",
    );
    // A dead reading that was fine stays quiet.
    expect(titleMark(viewOf({ fetched_at: at(72) }))).toBe("");
  });

  it("guards a zero window total in the model share", () => {
    expect(modelShare(viewOf({ rolling30_usd: 0 }), 0)).toBeNull();
    expect(modelShare(viewOf(), 125)).toBe(50);
  });

  it("gives the hub tile a percent, or a dash without data", () => {
    const r = parseIuBudget(fixture());
    expect(tileFragment(r, NOW)).toBe("IU 50%");
    expect(tileFragment({ kind: "missing" })).toBe("IU —");
  });
});
