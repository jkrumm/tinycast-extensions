import { describe, expect, it } from "vitest";
import { sampleInput, fakeIcon } from "./sheet-fixtures";
import { buildHyperSheet } from "./sheet";
import { renderHyperSheet } from "./sheet-html";

const render = (withWalkingPad = true) =>
  renderHyperSheet(buildHyperSheet(sampleInput(withWalkingPad), fakeIcon));

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("renderHyperSheet", () => {
  it("is one self-contained HTML document: inline CSS, data-URI icons, no script or network", () => {
    const html = render();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<img[^>]+src="(?!data:)/);
  });

  it("declares A4 landscape for print", () => {
    expect(render()).toContain("@page { size: A4 landscape; margin: 10mm; }");
  });

  it("shows the title, the generation date and the palette shortcut in the header", () => {
    const html = render();
    expect(html).toContain("<h1>Hyper = Caps Lock (⌃⌥⌘)</h1>");
    expect(html).toContain("<dd>2026-11-24</dd>");
    expect(html).toContain("<kbd>⌘Space</kbd>");
  });

  it("puts a captioned icon on every bound key cap and a quiet cap on the rest", () => {
    const html = render();
    // Obsidian, Zed, Helium, Dashboard and the three WalkingPad keys; Zed has no icon
    expect(count(html, 'class="key bound"')).toBe(7);
    expect(count(html, 'class="cap-icon"')).toBe(6);
    expect(count(html, 'class="key"')).toBeGreaterThan(40);
    expect(html).toContain('<span class="label">Delete</span>');
  });

  it("marks the Caps Lock cap as the Hyper key", () => {
    expect(render()).toContain('class="key hyper"');
  });

  it("shows a lettered tile for an app without an icon", () => {
    const html = render();
    expect(html).toContain(
      '<span class="legend-icon tile" aria-hidden="true">Z</span>',
    );
  });

  it("groups the legend as Apps, Commands and WalkingPad app", () => {
    const html = render();
    const apps = html.indexOf("<h2>Apps</h2>");
    const commands = html.indexOf("<h2>Commands</h2>");
    const walkingPad = html.indexOf("<h2>WalkingPad app</h2>");
    expect(apps).toBeGreaterThan(-1);
    expect(commands).toBeGreaterThan(apps);
    expect(walkingPad).toBeGreaterThan(commands);
  });

  it("leaves the WalkingPad group out when its domain is missing", () => {
    expect(render(false)).not.toContain("WalkingPad app");
  });

  it("escapes names from the Mac", () => {
    const html = render();
    expect(html).toContain("Helium &lt;Beta&gt; &amp; Co");
    expect(html).not.toContain("<Beta>");
  });
});
