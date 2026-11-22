import { describe, expect, it } from "vitest";
import { FixtureName, fixture, statusWith } from "./fixtures";
import {
  clampSpeed,
  formatDuration,
  formatSteps,
  parseStatus,
  phaseOf,
  statusMarkdown,
  steppedSpeed,
  tileStatus,
} from "./parse";
import { Phase } from "./types";

const status = (name: FixtureName) => {
  const parsed = parseStatus(fixture(name));
  if (!parsed) throw new Error(`${name} does not parse`);
  return parsed;
};

describe("parseStatus + phaseOf (golden fixtures)", () => {
  const cases: [FixtureName, Phase][] = [
    ["status-active", "active"],
    ["status-standby", "standby"],
    ["status-stopped", "standby"],
    ["status-starting", "starting"],
    ["status-stopping", "stopping"],
    ["status-disconnected", "padDisconnected"],
    ["status-unknown", "standby"],
  ];
  it.each(cases)("%s reads as %s", (name, phase) => {
    expect(phaseOf(status(name))).toBe(phase);
  });

  it("reads speed, session and totals", () => {
    expect(status("status-active").speedKmh).toBe(4.5);
    const walk = status("status-current-session").session;
    expect(walk).toMatchObject({ durationS: 120, distanceM: 70, steps: 110 });
    expect(walk?.maxSpeedKmh).toBe(4.5);
  });

  it("rejects what is not a status", () => {
    expect(parseStatus("garbage")).toBeNull();
    expect(parseStatus(fixture("ok"))).toBeNull();
    expect(parseStatus("[]")).toBeNull();
  });

  it("tolerates missing totals and an upper-case belt state", () => {
    const parsed = parseStatus('{"connected":true,"belt_state":"ACTIVE"}');
    expect(parsed && phaseOf(parsed)).toBe("active");
    expect(parsed?.today.steps).toBe(0);
  });
});

describe("speed grid", () => {
  it("clamps to 0.5..6.0 and rounds to 0.1", () => {
    expect(clampSpeed(0)).toBe(0.5);
    expect(clampSpeed(7)).toBe(6);
    expect(clampSpeed(3.04)).toBe(3);
  });
  it("steps onto the 0.5 grid", () => {
    expect(steppedSpeed(4.5, 1)).toBe(5);
    expect(steppedSpeed(3.2, 1)).toBe(3.5);
    expect(steppedSpeed(3.2, -1)).toBe(3);
    expect(steppedSpeed(6, 1)).toBe(6);
    expect(steppedSpeed(0.5, -1)).toBe(0.5);
  });
});

describe("text", () => {
  it("formats", () => {
    expect(formatDuration(754)).toBe("12:34");
    expect(formatDuration(4123)).toBe("1:08:43");
    expect(formatSteps(8740)).toBe("8,740");
  });

  it("renders a walk in progress and today's totals once", () => {
    const md = statusMarkdown(
      parseStatus(
        statusWith("status-active", {
          current_session: {
            duration_s: 754,
            distance_m: 942,
            steps: 1450,
            kcal: 38.2,
            avg_speed_kmh: 4.4,
            max_speed_kmh: 5,
          },
          today: { duration_s: 4123, distance_m: 5430, steps: 8740, kcal: 220 },
        }),
      ),
    );
    expect(md).toContain("# Walking · 4.5 km/h");
    expect(md).toContain("| Walk | 12:34 | 942 m | 1,450 | 38 kcal |");
    expect(md).toContain("| Today | 1:08:43 | 5.43 km | 8,740 | 220 kcal |");
    expect(md).not.toMatch(/NaN|undefined|null/);
  });

  it("says why the pad is not reachable", () => {
    const md = statusMarkdown(status("status-disconnected"));
    expect(md).toContain("# Pad not connected");
    expect(md).toContain("Switch the pad on");
  });

  it("makes a tile line, and goes quiet when the reading is old", () => {
    expect(tileStatus(status("status-active"))).toBe("▶ 4.5 km/h");
    expect(tileStatus(status("status-standby"))).toBe("Ready");
    expect(tileStatus(status("status-disconnected"))).toBe("Pad off");
    expect(tileStatus(status("status-active"), 10 * 60_000)).toBe("—");
    expect(tileStatus(null)).toBe("—");
  });
});
