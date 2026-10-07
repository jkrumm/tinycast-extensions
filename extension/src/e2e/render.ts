// Shared render/assert helpers for the e2e fixture and live suites. Uses
// react-test-renderer (no DOM/jsdom needed — it ships its own host config)
// wrapped in `act()` from `react` itself (the renderer-agnostic entry point
// as of React 19) so effects — including the fake useCachedPromise/usePromise
// hooks' fetch-on-mount effect — actually run. Verified against the
// installed react@19.0.0 (`act` is a named export) and react-test-renderer's
// own README before writing this — no jsdom/happy-dom/testing-library
// needed for this project's "render and inspect props" use case.
import { act } from "react";
import type { ReactElement } from "react";
import TestRenderer, { ReactTestRenderer } from "react-test-renderer";

export async function renderCommand(
  element: ReactElement,
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

// Polls with real timers (wrapped in `act` each tick so queued effects/state
// updates from a resolved fetch get flushed) until `check()` is true —
// "wait for loading to settle" without needing fake timers or a DOM.
export async function waitFor(
  check: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 10;
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    });
  }
}

const BAD_SUBSTRINGS = ["NaN", "undefined", "null"];

// The exact regression class this harness exists to catch: a formatter
// crashing on a missing value, or one silently stringifying into the
// rendered markdown/text instead of being handled.
export function assertNoBadSubstrings(text: string, context: string): void {
  for (const bad of BAD_SUBSTRINGS) {
    if (text.includes(bad)) {
      throw new Error(
        `${context}: rendered output contains "${bad}":\n${text}`,
      );
    }
  }
}

// The decoded SVG of the markdown image with this alt text
// (`![Stats](data:image/svg+xml;base64,…)`) — a stat card's label and value
// are SVG text, not markdown, so assertions on them read the image.
export function imageSvg(markdown: string, alt: string): string {
  const match = markdown.match(
    new RegExp(`!\\[${alt}\\]\\(data:image/svg\\+xml;base64,([^?)]+)`),
  );
  if (!match) throw new Error(`no "${alt}" image in the markdown`);
  return Buffer.from(match[1], "base64").toString("utf8");
}
