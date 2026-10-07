import { client as defaultClient } from "./client";
import { TickTickProject, TickTickTask } from "./types";

export interface OpenTasksResult {
  projects: TickTickProject[];
  tasks: TickTickTask[];
}

type TickTickClient = Pick<
  typeof defaultClient,
  "getProjects" | "getProjectData"
>;

// Shared by every command that needs "all open tasks across every project" —
// my-tasks and ticktick-menu-bar. Accepts a client override for tests.
export async function loadOpenTasks(
  ticktickClient: TickTickClient = defaultClient,
): Promise<OpenTasksResult> {
  const projects = await ticktickClient.getProjects();
  const results = await Promise.all(
    projects.map((p) => ticktickClient.getProjectData(p.id)),
  );
  const tasks = results.flatMap((r) => r.tasks).filter((t) => t.status === 0);
  return { projects, tasks };
}
