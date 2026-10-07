import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { Action, List } from "@raycast/api";
import { renderCommand, waitFor, assertNoBadSubstrings } from "./render";
import { TickTickProject, TickTickTask } from "../ticktick/types";
import { OpenTasksResult } from "../ticktick/load";

const loadOpenTasksMock = vi.fn<() => Promise<OpenTasksResult>>();
vi.mock("../ticktick/load", () => ({
  loadOpenTasks: () => loadOpenTasksMock(),
}));

import MyTasks from "../my-tasks";

const project: TickTickProject = {
  id: "p1",
  name: "HomeLab",
  color: "#ff0000",
  sortOrder: 0,
  closed: false,
  groupId: null,
  viewMode: "list",
  permission: "write",
  kind: "TASK",
};

function task(overrides: Partial<TickTickTask>): TickTickTask {
  return {
    id: "t1",
    projectId: "p1",
    title: "Do the thing",
    content: "",
    desc: "",
    isAllDay: true,
    isFloating: false,
    startDate: null,
    dueDate: null,
    completedTime: null,
    timeZone: "Europe/Berlin",
    repeatFlag: null,
    priority: 0,
    status: 0,
    sortOrder: 0,
    kind: "TEXT",
    ...overrides,
  };
}

describe("my-tasks command", () => {
  beforeEach(() => {
    loadOpenTasksMock.mockReset();
  });

  it("renders the task list without crashing", async () => {
    loadOpenTasksMock.mockResolvedValue({
      projects: [project],
      tasks: [task({ id: "t1", title: "Fix the router" })],
    });

    const renderer = await renderCommand(<MyTasks />);
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );

    const items = renderer.root.findAllByType(List.Item);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.props.title === "Fix the router")).toBe(true);
  });

  it("renders an empty state instead of crashing when there are no tasks", async () => {
    loadOpenTasksMock.mockResolvedValue({ projects: [], tasks: [] });
    const renderer = await renderCommand(<MyTasks />);
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );
    expect(renderer.root.findAllByType(List.EmptyView)).toHaveLength(1);
  });

  it("marks the navigationTitle offline (with age) when a refresh fails over cached data", async () => {
    loadOpenTasksMock.mockResolvedValueOnce({
      projects: [project],
      tasks: [task({ id: "t1", title: "Cached task" })],
    });
    const renderer = await renderCommand(<MyTasks />);
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );
    expect(renderer.root.findByType(List).props.navigationTitle).toBe("Tasks");

    loadOpenTasksMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const refresh = renderer.root
      .findAllByType(Action)
      .find((a) => a.props.title === "Aktualisieren")!;
    await act(async () => {
      refresh.props.onAction();
    });
    await waitFor(
      () => renderer.root.findByType(List).props.isLoading === false,
    );

    const title = renderer.root.findByType(List).props
      .navigationTitle as string;
    expect(title).toBe("Tasks · offline, from just now");

    const items = renderer.root.findAllByType(List.Item).map((i) => i.props);
    expect(items.some((i) => i.title === "Cached task")).toBe(true);
    assertNoBadSubstrings(title, "my-tasks offline navigationTitle");
    assertNoBadSubstrings(
      items.map((i) => String(i.title)).join(", "),
      "my-tasks offline item titles",
    );
  });
});
