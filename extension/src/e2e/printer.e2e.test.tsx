import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { ReactTestRenderer } from "react-test-renderer";
import { List } from "@raycast/api";
import { assertNoBadSubstrings, renderCommand, waitFor } from "./render";
import type { PrinterView } from "../print/parse";

// Only the impure calls are mocked: the printer state comes from the fixture.
const state = vi.hoisted(() => ({
  view: null as unknown as PrinterView,
}));

vi.mock("../print/view-run", () => ({
  loadPrinter: () => Promise.resolve(state.view),
  loadSelection: () => Promise.resolve([]),
  printSelection: vi.fn(),
  cancelJob: vi.fn(),
  cancelAll: vi.fn(),
}));

import Printer from "../printer";

const idleLowToner: PrinterView = {
  ok: true,
  printer: "Example_Printer",
  state: "idle",
  accepting: true,
  reasons: ["toner-low-warning"],
  tonerPercent: 10,
  tonerLow: true,
  jobs: [
    {
      id: "Example_Printer-26",
      title: "Example-Invoice.pdf",
      state: "processing",
      reasons: [],
      user: "user",
      submittedAt: 1795782227,
      sheets: 3,
    },
    {
      id: "Example_Printer-27",
      title: "",
      state: "pending-held",
      reasons: ["job-hold-until-specified"],
      user: "user",
      submittedAt: null,
      sheets: null,
    },
  ],
};

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  renderer?.unmount();
  renderer = null;
});

async function mount(view: PrinterView): Promise<ReactTestRenderer> {
  state.view = view;
  renderer = await renderCommand(<Printer />);
  await waitFor(() => renderer!.root.findAllByType(List.Item).length > 0);
  return renderer;
}

const items = (r: ReactTestRenderer) => r.root.findAllByType(List.Item);

describe("printer view", () => {
  it("shows the state with the toner warning and the jobs", async () => {
    const r = await mount(idleLowToner);
    const rows = items(r);
    const text = rows
      .map((row) => `${row.props.title} ${row.props.subtitle ?? ""}`)
      .join("\n");
    assertNoBadSubstrings(text, "printer view");

    const printerRow = rows.find((row) => row.props.title === "Idle");
    expect(printerRow).toBeDefined();
    expect(printerRow!.props.accessories[0].tag.value).toBe("toner 10 %");
    expect(printerRow!.props.accessories[0].icon).toBeDefined();

    const invoice = rows.find(
      (row) => row.props.title === "Example-Invoice.pdf",
    );
    expect(invoice!.props.subtitle).toMatch(/^Printing · \d{2}:\d{2}$/);

    const held = rows.find((row) => row.props.title === "Example_Printer-27");
    expect(held!.props.subtitle).toBe("Held");
  });

  it("says there are no jobs when the queue is empty", async () => {
    const r = await mount({
      ...idleLowToner,
      reasons: [],
      tonerPercent: 80,
      tonerLow: false,
      jobs: [],
    });
    const rows = items(r);
    const quiet = rows.find((row) => row.props.title === "No jobs");
    expect(quiet).toBeDefined();
    const printerRow = rows.find((row) => row.props.title === "Idle");
    expect(printerRow!.props.accessories).toEqual([{ text: "toner 80 %" }]);
  });

  it("shows an unreachable printer with the reason and no jobs", async () => {
    const r = await mount({
      ok: false,
      message: 'No printer named "no-such-queue"',
    });
    const rows = items(r);
    const row = rows.find((item) => item.props.title === "Printer unavailable");
    expect(row).toBeDefined();
    expect(row!.props.subtitle).toBe('No printer named "no-such-queue"');
    expect(rows.some((item) => item.props.title === "No jobs")).toBe(false);
    assertNoBadSubstrings(String(row!.props.subtitle), "unreachable printer");
  });
});
