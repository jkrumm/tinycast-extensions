import { describe, expect, it } from "vitest";
import {
  formatClock,
  hudLine,
  parseState,
  stateMarkdown,
  statusTitle,
  tileStatus,
  volumeAbsolute,
  volumeDelta,
} from "./parse";

const full = JSON.stringify({
  status: "paused",
  active: true,
  volume: 40,
  output: "LG SJ3(85)",
  track: "Charmed",
  artists: ["Σtella", "Redinho"],
  album: "Up and Away",
  context: "Chillig 🫠",
  cover: "https://i.scdn.co/image/abc",
  position_ms: 87121,
  duration_ms: 158359,
  shuffle: true,
  repeat: "off",
});

describe("parseState", () => {
  it("reads the full CLI shape", () => {
    const state = parseState(full);
    expect(state).toMatchObject({
      status: "paused",
      active: true,
      volume: 40,
      track: "Charmed",
      artists: ["Σtella", "Redinho"],
      positionMs: 87121,
      durationMs: 158359,
      shuffle: true,
    });
  });

  it("tolerates missing and mistyped fields", () => {
    const state = parseState(
      '{"status":null,"volume":"loud","artists":[1,"A"]}',
    );
    expect(state).toMatchObject({
      status: null,
      volume: null,
      track: null,
      artists: ["A"],
      active: null,
    });
  });

  it("returns null for garbage", () => {
    expect(parseState("nope")).toBeNull();
    expect(parseState("[1]")).toBeNull();
    expect(parseState("")).toBeNull();
  });
});

describe("volume arguments", () => {
  it("formats relative and clamps absolute", () => {
    expect(volumeDelta(10)).toBe("+10");
    expect(volumeDelta(-30)).toBe("-30");
    expect(volumeAbsolute(140)).toBe("100");
    expect(volumeAbsolute(-5)).toBe("0");
    expect(volumeAbsolute(33.6)).toBe("34");
  });
});

describe("hudLine", () => {
  it("shows icon, track, artists and volume", () => {
    const playing = parseState(full.replace("paused", "playing"))!;
    expect(hudLine(playing)).toBe("▶ Charmed — Σtella, Redinho · 40 %");
    expect(hudLine(parseState(full)!)).toBe(
      "⏸ Charmed — Σtella, Redinho · 40 %",
    );
  });

  it("says idle without a track and omits a missing volume", () => {
    expect(hudLine(parseState("{}")!)).toBe("Spotify idle");
    expect(hudLine(parseState('{"track":"A","status":"playing"}')!)).toBe(
      "▶ A",
    );
  });
});

describe("stateMarkdown", () => {
  it("renders cover, title, artists and a facts table", () => {
    const md = stateMarkdown(parseState(full));
    expect(md).toContain("![](https://i.scdn.co/image/abc)");
    expect(md).toContain("# Charmed");
    expect(md).toContain("**Σtella, Redinho**");
    expect(md).toContain("| Volume | 40 % |");
    expect(md).toContain("| Output | LG SJ3(85) |");
    expect(md).toContain("| Active device | Mine |");
    expect(md).toContain("| Position | 1:27 / 2:38 |");
  });

  it("copes with an empty state and no state", () => {
    expect(stateMarkdown(parseState("{}"))).toContain("# Nothing loaded");
    expect(stateMarkdown(null)).toContain("No reading yet");
  });

  it("escapes markdown in titles", () => {
    const md = stateMarkdown(parseState('{"track":"a_b*c"}'));
    expect(md).toContain("# a\\_b\\*c");
  });
});

describe("small formatters", () => {
  it("formats clocks", () => {
    expect(formatClock(5000)).toBe("0:05");
    expect(formatClock(null)).toBeNull();
  });
  it("titles status and tile", () => {
    expect(statusTitle(parseState(full))).toBe("Paused");
    expect(statusTitle(null)).toBe("Spotify on Mine");
    expect(tileStatus(null)).toBe("Idle");
    expect(tileStatus(parseState(full))).toBe("⏸ Charmed");
  });
});
