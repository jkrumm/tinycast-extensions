import {
  Color,
  Icon,
  MenuBarExtra,
  open,
  showToast,
  Toast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo } from "react";
import { client } from "./ticktick/client";
import { loadOpenTasks } from "./ticktick/load";
import { TickTickTask } from "./ticktick/types";
import {
  formatDue,
  isOverdue,
  isDueToday,
  priorityIcon,
  daysFromNow,
  taskDate,
} from "./ticktick/format";
import { stamped } from "./lib/freshness";

const TICKTICK_URL = "https://ticktick.com/webapp";

function taskMenuIcon(task: TickTickTask): { source: Icon; tintColor: Color } {
  if (isOverdue(task.dueDate))
    return { source: Icon.ExclamationMark, tintColor: Color.Red };
  if (isDueToday(task.dueDate))
    return { source: Icon.Clock, tintColor: Color.Orange };
  return priorityIcon(task.priority);
}

function TaskItem({
  task,
  onComplete,
}: {
  task: TickTickTask;
  onComplete: (task: TickTickTask) => void;
}) {
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
          onAction={() => onComplete(task)}
        />
      }
    />
  );
}

export default function MenuBar() {
  const { data, isLoading, error, revalidate } = useCachedPromise(
    () => stamped(loadOpenTasks),
    [],
    { keepPreviousData: true, onError: () => {} },
  );
  const allTasks = data?.data.tasks ?? [];
  const offline = !!error;

  const overdue = useMemo(
    () => allTasks.filter((t) => isOverdue(t.dueDate)),
    [allTasks],
  );
  const dueToday = useMemo(
    () => allTasks.filter((t) => isDueToday(t.dueDate)),
    [allTasks],
  );
  const upcoming = useMemo(() => {
    const end = daysFromNow(3);
    return allTasks.filter((t) => {
      if (!t.dueDate || isOverdue(t.dueDate) || isDueToday(t.dueDate))
        return false;
      return taskDate(t.dueDate) <= end;
    });
  }, [allTasks]);

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
        title: "Fehler",
        message: String(e),
      });
    }
  }

  return (
    <MenuBarExtra
      icon={menuIcon}
      title={
        urgentCount > 0
          ? `${urgentCount}${offline ? " (offline)" : ""}`
          : undefined
      }
      tooltip={`TickTick Tasks${offline ? " (offline)" : ""}`}
      isLoading={isLoading}
    >
      {overdue.length > 0 && (
        <MenuBarExtra.Section title={`Überfällig (${overdue.length})`}>
          {overdue.map((t) => (
            <TaskItem key={t.id} task={t} onComplete={markComplete} />
          ))}
        </MenuBarExtra.Section>
      )}

      {dueToday.length > 0 && (
        <MenuBarExtra.Section title="Heute">
          {dueToday.map((t) => (
            <TaskItem key={t.id} task={t} onComplete={markComplete} />
          ))}
        </MenuBarExtra.Section>
      )}

      {upcoming.length > 0 && (
        <MenuBarExtra.Section title="Bald">
          {upcoming.map((t) => (
            <TaskItem key={t.id} task={t} onComplete={markComplete} />
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
