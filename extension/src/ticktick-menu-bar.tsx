import {
  Color,
  Icon,
  MenuBarExtra,
  open,
  showToast,
  Toast,
} from "@raycast/api";
import { useFetch } from "@raycast/utils";
import { useMemo, useState } from "react";
import { prefs, useAuthHeaders } from "./lib/argo";
import { client } from "./ticktick/client";
import { TickTickProject, TickTickTask } from "./ticktick/types";
import {
  formatDue,
  isOverdue,
  isDueToday,
  priorityIcon,
  daysFromNow,
} from "./ticktick/format";

const TICKTICK_URL = "https://ticktick.com/webapp";

function taskMenuIcon(task: TickTickTask): { source: Icon; tintColor: Color } {
  if (isOverdue(task.dueDate))
    return { source: Icon.ExclamationMark, tintColor: Color.Red };
  if (isDueToday(task.dueDate))
    return { source: Icon.Clock, tintColor: Color.Orange };
  return priorityIcon(task.priority);
}

export default function MenuBar() {
  const [allTasks, setAllTasks] = useState<TickTickTask[]>([]);
  const [isFetchingTasks, setIsFetchingTasks] = useState(false);

  const base = prefs().baseUrl.replace(/\/$/, "");
  const { headers, isLoading: authLoading, ready } = useAuthHeaders();

  const { isLoading: projectsLoading, revalidate } = useFetch<{
    data: TickTickProject[];
  }>(`${base}/ticktick/projects`, {
    headers,
    execute: ready,
    keepPreviousData: true,
    onData: (raw) => {
      const projects = raw?.data ?? [];
      if (projects.length === 0) return;
      setIsFetchingTasks(true);
      Promise.all(projects.map((p) => client.getProjectData(p.id)))
        .then((results) => {
          const tasks = results
            .flatMap((r) => r.tasks)
            .filter((t) => t.status === 0);
          setAllTasks(tasks);
        })
        .catch(() => {
          /* silent — menu bar shouldn't crash */
        })
        .finally(() => setIsFetchingTasks(false));
    },
  });

  const isLoading = authLoading || projectsLoading || isFetchingTasks;

  const overdue = useMemo(
    () => allTasks.filter((t) => isOverdue(t.dueDate)),
    [allTasks],
  );
  const dueToday = useMemo(
    () => allTasks.filter((t) => isDueToday(t.dueDate)),
    [allTasks],
  );
  const end = daysFromNow(3);
  const upcoming = useMemo(
    () =>
      allTasks.filter((t) => {
        if (!t.dueDate || isOverdue(t.dueDate) || isDueToday(t.dueDate))
          return false;
        return t.dueDate.slice(0, 10) <= end;
      }),
    [allTasks], // end intentionally omitted — recalculated on allTasks change
  );

  const urgentCount = overdue.length + dueToday.length;
  const menuIcon =
    urgentCount > 0
      ? { source: Icon.ExclamationMark, tintColor: Color.Red }
      : { source: Icon.CheckCircle, tintColor: Color.Green };

  async function markComplete(task: TickTickTask) {
    try {
      await client.completeTask(task.projectId, task.id);
      revalidate();
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed",
        message: String(e),
      });
    }
  }

  function TaskItem({ task }: { task: TickTickTask }) {
    const due = formatDue(task.dueDate);
    return (
      <MenuBarExtra.Item
        icon={taskMenuIcon(task)}
        title={due ? `${task.title}  ${due}` : task.title}
        onAction={() => open(`${TICKTICK_URL}/#q/today/tasks/${task.id}`)}
        alternate={
          <MenuBarExtra.Item
            icon={{ source: Icon.Checkmark, tintColor: Color.Green }}
            title={`Done: ${task.title}`}
            onAction={() => markComplete(task)}
          />
        }
      />
    );
  }

  return (
    <MenuBarExtra
      icon={menuIcon}
      title={urgentCount > 0 ? String(urgentCount) : undefined}
      tooltip="TickTick Tasks"
      isLoading={isLoading}
    >
      {overdue.length > 0 && (
        <MenuBarExtra.Section title={`Overdue (${overdue.length})`}>
          {overdue.map((t) => (
            <TaskItem key={t.id} task={t} />
          ))}
        </MenuBarExtra.Section>
      )}

      {dueToday.length > 0 && (
        <MenuBarExtra.Section title="Today">
          {dueToday.map((t) => (
            <TaskItem key={t.id} task={t} />
          ))}
        </MenuBarExtra.Section>
      )}

      {upcoming.length > 0 && (
        <MenuBarExtra.Section title="Coming Up">
          {upcoming.map((t) => (
            <TaskItem key={t.id} task={t} />
          ))}
        </MenuBarExtra.Section>
      )}

      {overdue.length === 0 &&
        dueToday.length === 0 &&
        upcoming.length === 0 &&
        !isLoading && (
          <MenuBarExtra.Section>
            <MenuBarExtra.Item
              icon={{ source: Icon.Checkmark, tintColor: Color.Green }}
              title="All clear — nothing urgent"
            />
          </MenuBarExtra.Section>
        )}

      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Open TickTick"
          icon={Icon.Globe}
          shortcut={{ modifiers: ["cmd"], key: "o" }}
          onAction={() => open(TICKTICK_URL)}
        />
        <MenuBarExtra.Item
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={{ modifiers: ["cmd"], key: "r" }}
          onAction={revalidate}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
