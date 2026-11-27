import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
import { Grid } from "@raycast/api";
import { __resetToasts, __toasts } from "./raycast-fake";
import { assertNoBadSubstrings, renderCommand, waitFor } from "./render";
import type { DocThumb, DocumentsResult, ScanStatus } from "../scan/view";

// Synthetic documents only: the real index is private.
const state = vi.hoisted(() => ({
  status: { pending: null } as ScanStatus,
  docs: { ok: true } as unknown,
  thumbs: [] as DocThumb[],
}));

vi.mock("../scan/view-run", () => ({
  loadStatus: () => Promise.resolve(state.status),
  loadDocuments: () => Promise.resolve(state.docs),
  loadDocThumbs: () => Promise.resolve(state.thumbs),
  submitScan: vi.fn(),
  discardScan: vi.fn(),
  releaseDocument: vi.fn(),
  startScan: vi.fn(),
  scanLogPath: () => "/state/scan.log",
}));

import Scanner from "../scanner";

type Part = NonNullable<ScanStatus["pending"]>["parts"][number];
const part = (mode: string, pages: number, noThumb: number[] = []): Part => ({
  mode,
  fileName: `scan-${mode}.pdf`,
  pages,
  at: 1,
  pagePaths: Array.from(
    { length: pages },
    (_, i) => `/s/${mode}/page-${i + 1}.jpg`,
  ),
  thumbPaths: Array.from({ length: pages }, (_, i) =>
    noThumb.includes(i) ? null : `/s/${mode}/thumb-${i + 1}.jpg`,
  ),
  pdfPath: `/s/${mode}/scan.pdf`,
});

const noDocs: DocumentsResult = {
  ok: true,
  waiting: [],
  review: [],
  done: [],
  filed: [],
  filedAsOf: null,
  filedNote: "Document index not found",
};

const allDocs: DocumentsResult = {
  ok: true,
  waiting: [
    {
      name: "scan-2026-11-26-181500.pdf",
      path: "/in/scan-2026-11-26-181500.pdf",
      size: 140_000,
      mtime: 5,
    },
  ],
  review: [
    {
      name: "mixed-pages.pdf",
      path: "/in/review/mixed-pages.pdf",
      mtime: 4,
      why: "two documents in one file\nproposal: kind letter",
    },
    {
      name: "scan-2026-01-02-101010.pdf",
      path: "/in/review/scan-2026-01-02-101010.pdf",
      mtime: 3,
      why: "unsure where the stack splits\nproposal: 5 documents, pages 1-8, 9, 10-11, 12-13, 14-15",
      proposedSplit: {
        documents: 5,
        ranges: ["1-8", "9", "10-11", "12-13", "14-15"],
        starts: [9, 10, 12, 14],
      },
    },
  ],
  done: [],
  filed: [
    {
      title: "2026-03 Example Gas Invoice",
      kind: "invoice",
      issuer: "Example Utilities GmbH",
      date: "2026-03-14",
      tags: ["energy", "gas"],
      summary: "Gas invoice for March. Due in 14 days.",
      path: "/Dokumente/Finanzen/gas.pdf",
      notePath: "/brain/Areas/Documents/2026/gas.md",
      exists: true,
    },
    {
      title: "2026-02 Sample Authority Letter",
      kind: "letter",
      issuer: "Sample Authority",
      date: "2026-02-02",
      tags: [],
      summary: "A letter about a sample matter.",
      path: "/Dokumente/Briefe/letter.pdf",
      notePath: "/brain/Areas/Documents/2026/letter.md",
      exists: false,
    },
  ],
  filedAsOf: new Date(2026, 10, 26, 14, 20).getTime(),
};

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  state.status = { pending: null };
  state.docs = noDocs;
  state.thumbs = [];
});
afterEach(() => {
  renderer?.unmount();
  renderer = null;
});

const typeName = (n: ReactTestInstance): string =>
  typeof n.type === "string"
    ? n.type
    : ((n.type as { displayName?: string }).displayName ?? "");

async function mount(): Promise<ReactTestRenderer> {
  renderer = await renderCommand(<Scanner />);
  await waitFor(
    () =>
      renderer!.root.findAllByType(Grid.Item).length > 0 ||
      renderer!.root.findByType(Grid).props.isLoading === false,
  );
  return renderer;
}

const sections = (r: ReactTestRenderer) =>
  r.root.findAllByType(Grid.Section).map((s) => ({
    title: s.props.title as string,
    items: s.findAllByType(Grid.Item),
  }));

const isAction = (n: ReactTestInstance): boolean => {
  const name = typeName(n);
  return (
    (name === "Action" || name.startsWith("Action.")) &&
    typeof n.props.title === "string"
  );
};

// Action titles in panel order, as the user would see them.
const actionTitles = (node: ReactTestInstance): string[] =>
  node.findAll(isAction).map((n) => n.props.title as string);

// The panel of a tile is a prop (not a child), so render it from the props.
const itemActions = (item: ReactTestInstance): string[] => {
  const panel = item.props.actions as React.ReactElement | undefined;
  if (!panel) return [];
  const titles: string[] = [];
  const walk = (node: React.ReactNode): void => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      const props = child.props as {
        title?: string;
        children?: React.ReactNode;
      };
      const type = child.type as { displayName?: string } | string;
      const name = typeof type === "string" ? type : (type.displayName ?? "");
      if (name === "Action.ShowInFinder") titles.push("Show in Finder");
      else if (
        (name === "Action" || name.startsWith("Action.")) &&
        typeof props.title === "string"
      ) {
        titles.push(props.title);
      }
      walk(props.children);
    });
  };
  walk(panel);
  return titles;
};

// Everything the view renders as text, for the NaN/undefined/null check.
function allText(r: ReactTestRenderer): string {
  const strings: string[] = [];
  for (const node of r.root.findAll(() => true)) {
    for (const key of [
      "title",
      "subtitle",
      "description",
      "navigationTitle",
      "searchBarPlaceholder",
      "markdown",
    ]) {
      if (typeof node.props[key] === "string") strings.push(node.props[key]);
    }
  }
  return strings.join("\n");
}

describe("scanner view", () => {
  it("shows the empty state and the missing-index note, and offers the scans", async () => {
    const r = await mount();
    const empty = r.root.findByType(Grid.EmptyView);
    expect(empty.props.title).toBe("Nothing scanned yet");
    expect(empty.props.description).toBe(
      "Put the stack in the feeder and press Enter to scan",
    );
    expect(actionTitles(empty)).toEqual([
      "Scan Document",
      "Scan Fronts",
      "Scan Flatbed",
      "Open Scan Log",
      "Refresh",
    ]);
    // the filed list is missing: one note, no sections for the rest
    expect(sections(r).map((s) => s.title)).toEqual(["Recently filed"]);
    expect(sections(r)[0].items[0].props.title).toBe(
      "Document index not found",
    );
    expect(r.root.findByType(Grid).props.navigationTitle).toBe("Scanner");
    assertNoBadSubstrings(allText(r), "scanner empty");
  });

  it("renders one pending part with its thumbnails and every kind of document", async () => {
    state.status = {
      pending: {
        parts: [part("feeder", 3, [1])],
        scanning: false,
        needsAttention: false,
      },
    };
    state.docs = allDocs;
    state.thumbs = [
      { path: "/in/scan-2026-11-26-181500.pdf", thumbPath: "/cache/w.jpg" },
      { path: "/Dokumente/Finanzen/gas.pdf", thumbPath: "/cache/f.jpg" },
    ];
    const r = await mount();
    await waitFor(() =>
      sections(r).some((s) =>
        s.items.some((i) => i.props.content === "/cache/w.jpg"),
      ),
    );
    const secs = sections(r);
    expect(secs.map((s) => s.title)).toEqual([
      "Scan · 3 pages",
      "Needs review",
      "Waiting in the inbox",
      "Recently filed · as of 14:20",
    ]);

    // the pages: the thumbnail file, the document icon where one is missing
    const pages = secs[0].items;
    expect(pages.map((p) => p.props.title)).toEqual([
      "Page 1",
      "Page 2",
      "Page 3",
    ]);
    expect(pages[0].props.content).toBe("/s/feeder/thumb-1.jpg");
    expect(pages[1].props.content).toBe("icon:Document");
    // Submit is the flow's primary action on a page, then Open Page / Open PDF
    expect(itemActions(pages[0])).toEqual([
      "Submit Scan",
      "Scan More",
      "Discard Scan",
      "Scan Document",
      "Scan Fronts",
      "Scan Flatbed",
      "Open Page",
      "Open PDF",
      "Open Scan Log",
      "Refresh",
    ]);

    const [reviewTile] = secs[1].items;
    expect(reviewTile.props.title).toBe("mixed-pages.pdf");
    expect(reviewTile.props.subtitle).toBe("letter");
    // Show Details is the primary action on a review tile
    expect(itemActions(reviewTile).slice(0, 5)).toEqual([
      "Show Details",
      "Open",
      "File as One Document",
      "Show in Finder",
      "Copy Path",
    ]);
    // a proposed split: its action first, the one-document action second
    const [, splitTile] = secs[1].items;
    expect(splitTile.props.title).toBe("scan-2026-01-02-101010.pdf");
    expect(splitTile.props.subtitle).toBe(
      "Proposed: 5 documents (pages 1-8, 9, 10-11, 12-13, 14-15)",
    );
    expect(itemActions(splitTile).slice(0, 3)).toEqual([
      "File as Proposed (5 Documents)",
      "File as One Document",
      "Show Details",
    ]);
    const [waitingTile] = secs[2].items;
    expect(waitingTile.props.title).toBe("scan-2026-11-26-181500.pdf");
    expect(waitingTile.props.subtitle).toBe("waiting");
    expect(waitingTile.props.content).toBe("/cache/w.jpg");

    const [filedTile, missingTile] = secs[3].items;
    expect(filedTile.props.title).toBe("Example Utilities GmbH");
    expect(filedTile.props.subtitle).toBe("invoice · 2026-03-14");
    expect(filedTile.props.content).toBe("/cache/f.jpg");
    expect(filedTile.props.keywords).toContain("gas");
    expect(itemActions(filedTile).slice(0, 4)).toEqual([
      "Open",
      "Show in Finder",
      "Copy Path",
      "Show Details",
    ]);
    // a filed document whose file is missing: no Open, no Finder, still a path
    expect(missingTile.props.subtitle).toBe("file not found");
    expect(missingTile.props.content).toBe("icon:Document");
    const missingActions = itemActions(missingTile);
    expect(missingActions).not.toContain("Open");
    expect(missingActions).not.toContain("Show in Finder");
    expect(missingActions).toContain("Copy Path");
    // the flow stays available on every tile
    expect(missingActions).toContain("Submit Scan");

    assertNoBadSubstrings(allText(r), "scanner dashboard");
  });

  it("titles fronts and backs and notes a count mismatch", async () => {
    state.status = {
      pending: {
        parts: [part("fronts", 3), part("backs", 2)],
        scanning: false,
        needsAttention: false,
      },
    };
    const r = await mount();
    expect(
      sections(r)
        .map((s) => s.title)
        .slice(0, 2),
    ).toEqual(["Fronts · 3 pages", "Backs · 2 pages (fronts had 3)"]);
    // fronts + backs: Submit first, no new-scan group
    expect(itemActions(sections(r)[0].items[0])).toEqual([
      "Submit Scan",
      "Scan More",
      "Discard Scan",
      "Open Page",
      "Open PDF",
      "Open Scan Log",
      "Refresh",
    ]);
  });

  it("offers Scan Backs and Submit Fronts Only for pending fronts", async () => {
    state.status = {
      pending: {
        parts: [part("fronts", 3)],
        scanning: false,
        needsAttention: false,
      },
    };
    const r = await mount();
    expect(itemActions(sections(r)[0].items[0]).slice(0, 4)).toEqual([
      "Scan Backs",
      "Scan More",
      "Submit Fronts Only",
      "Discard Scan",
    ]);
  });

  it("marks a failed Scan More: section title, a warning tile first, Submit asks", async () => {
    state.status = {
      pending: {
        parts: [part("feeder", 26)],
        scanning: false,
        needsAttention: true,
        attention:
          "Scan stopped: all 3 pages look blank. Stack upside down? PDF kept in ~/.local/state/scan/blank",
      },
    };
    const r = await mount();
    const [first] = sections(r);
    expect(first.title).toBe("Scan · 26 pages · last batch failed");
    const [warning, page1] = first.items;
    expect(warning.props.title).toBe("Last batch failed");
    expect(warning.props.content).toBe("icon:Warning");
    expect(warning.props.subtitle).toMatch(
      /^Scan stopped: all 3 pages look blank/,
    );
    expect(warning.props.subtitle.length).toBeLessThanOrEqual(60);
    expect(page1.props.title).toBe("Page 1");
    expect(itemActions(warning)[0]).toBe("Submit Scan");
    assertNoBadSubstrings(allText(r), "scanner attention");
  });

  // The onAction of the action with this title in a panel passed as a prop.
  function onActionOf(item: ReactTestInstance, title: string) {
    let found: (() => void) | undefined;
    const walk = (node: React.ReactNode): void => {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement(child)) return;
        const props = child.props as {
          title?: string;
          onAction?: () => void;
          children?: React.ReactNode;
        };
        if (props.title === title && props.onAction) found ??= props.onAction;
        walk(props.children);
      });
    };
    walk(item.props.actions);
    return found;
  }

  it("toasts a result that appears after the view opened, not the one that was there", async () => {
    __resetToasts();
    state.status = {
      pending: null,
      lastResult: {
        at: 100,
        action: "feeder",
        ok: true,
        message: "old",
        pages: 3,
      },
    };
    const r = await mount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(__toasts).toEqual([]);

    // a scan ended: the next poll sees a newer lastResult
    state.status = {
      pending: null,
      lastResult: {
        at: 200,
        action: "more",
        ok: false,
        message: "Scanner is busy",
      },
    };
    onActionOf(r.root.findByType(Grid.EmptyView), "Refresh")!();
    await waitFor(() => __toasts.length > 0);
    expect(__toasts).toHaveLength(1);
    expect(__toasts[0]).toMatchObject({
      style: "failure",
      title: "Scanner is busy",
    });
  });

  it("shows the progress while a scan runs and offers no scan action", async () => {
    state.status = {
      pending: null,
      progress: { mode: "feeder", page: 5, startedAt: 1, pid: 7 },
    };
    const r = await mount();
    const grid = r.root.findByType(Grid);
    expect(grid.props.navigationTitle).toBe("Scanning… page 5");
    expect(grid.props.searchBarPlaceholder).toBe("Scanning… page 5");
    const empty = r.root.findByType(Grid.EmptyView);
    expect(empty.props.title).toBe("Scanning… page 5");
    expect(empty.props.description).toBe("Keep the stack in the feeder");
    expect(actionTitles(empty)).toEqual(["Open Scan Log", "Refresh"]);
    assertNoBadSubstrings(allText(r), "scanner scanning");
  });

  it("shows why the document list is missing when the inbox is not there", async () => {
    state.docs = {
      ok: false,
      message: "Scan inbox not found (is the share mounted?)",
    };
    const r = await mount();
    expect(sections(r)[0].items[0].props.title).toBe(
      "Scan inbox not found (is the share mounted?)",
    );
  });
});
