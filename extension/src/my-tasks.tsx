import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Detail,
  Icon,
  List,
  LocalStorage,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useEffect, useMemo, useState } from "react";
import { client } from "./ticktick/client";
import { loadOpenTasks } from "./ticktick/load";
import { TickTickProject, TickTickTask } from "./ticktick/types";
import {
  BUCKET_ORDER,
  BUCKET_TITLE,
  DueBucket,
  dueBucket,
  dueDateColor,
  formatDue,
  isOverdue,
  isDueToday,
  isDueTomorrow,
  priorityColor,
  priorityIcon,
  priorityLabel,
  daysFromNow,
  today,
  taskDate,
  nextSaturday,
} from "./ticktick/format";
import { parseSearch, applySearch } from "./ticktick/search";
import QuickAdd from "./quick-add";
import CreateTask from "./ticktick/create-task";
import { Stamped, formatAge, stamped } from "./lib/freshness";

// ─── Sort ─────────────────────────────────────────────────────────────────────

function sortTasks(tasks: TickTickTask[]): TickTickTask[] {
  return [...tasks].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return b.priority - a.priority;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    const dateCmp = a.dueDate.localeCompare(b.dueDate);
    return dateCmp !== 0 ? dateCmp : b.priority - a.priority;
  });
}

// ─── Filter ───────────────────────────────────────────────────────────────────

function applyFilter(tasks: TickTickTask[], filter: string): TickTickTask[] {
  if (filter.startsWith("project:")) {
    const id = filter.slice(8);
    return tasks.filter((t) => t.projectId === id);
  }
  switch (filter) {
    case "today":
      return tasks.filter((t) => isDueToday(t.dueDate) || isOverdue(t.dueDate));
    case "overdue":
      return tasks.filter((t) => isOverdue(t.dueDate));
    case "tomorrow":
      return tasks.filter((t) => isDueTomorrow(t.dueDate));
    case "week": {
      const end = daysFromNow(7);
      const todayStr = today();
      return tasks.filter(
        (t) =>
          !!t.dueDate &&
          taskDate(t.dueDate) >= todayStr &&
          taskDate(t.dueDate) <= end,
      );
    }
    case "weekend": {
      const todayStr = today();
      return tasks.filter((t) => {
        if (!t.dueDate) return false;
        const d = taskDate(t.dueDate);
        if (d < todayStr) return false;
        const day = new Date(d + "T12:00:00").getDay();
        return day === 0 || day === 6;
      });
    }
    case "no-date":
      return tasks.filter((t) => !t.dueDate);
    case "high":
      return tasks.filter((t) => t.priority >= 5);
    case "medium":
      return tasks.filter((t) => t.priority === 3);
    case "low":
      return tasks.filter((t) => t.priority === 1);
    case "none":
      return tasks.filter((t) => t.priority === 0);
    default:
      return tasks;
  }
}

// ─── Shortcuts Help ───────────────────────────────────────────────────────────

const SHORTCUTS_MARKDOWN = `
# TickTick Shortcuts

## Aufgaben
- \`↩\` Als erledigt markieren
- \`⌘E\` Aufgabe bearbeiten
- \`⌘↩\` In TickTick öffnen
- \`⌃X\` Aufgabe löschen

## Fälligkeit
- \`⌘T\` Morgen
- \`⌘S\` Nächste Woche (snooze +7 Tage)
- \`⌘D\` Fälligkeit ändern _(heute · morgen · Wochenende · nächste Woche · kein Datum)_

## Organisation
- \`⌘U\` Priorität ändern _(hoch · mittel · niedrig · keine)_
- \`⌘M\` Projekt wechseln

## Navigation & Suche
- \`⌘P\` Filter-Dropdown öffnen
- \`⌘N\` Neue Aufgabe (Quick Add)
- \`⌘R\` Aktualisieren
- \`⌘⇧D\` Detail-Ansicht umschalten
- \`⌘H\` Diese Hilfe

## Suchsyntax
- \`#projekt\` Nach Projekt filtern
- \`!h\` \`!m\` \`!l\` \`!n\` Priorität hoch · mittel · niedrig · keine
- \`heute\` \`morgen\` \`wochenende\` Nach Fälligkeit filtern
- \`überfällig\` \`kein datum\` \`woche\` Weitere Datumsfilter

## Global (Raycast)
- \`⌥Space\` Aufgabenliste öffnen
- \`⌥A\` Quick Add öffnen
`.trim();

function ShortcutsHelp() {
  return <Detail navigationTitle="Shortcuts" markdown={SHORTCUTS_MARKDOWN} />;
}

// ─── Task Actions ─────────────────────────────────────────────────────────────

function TaskActions({
  task,
  projects,
  onPatch,
  onRemove,
  onRefresh,
  onToggleDetail,
}: {
  task: TickTickTask;
  projects: TickTickProject[];
  onPatch: (changes: Partial<TickTickTask>) => void;
  onRemove: () => void;
  onRefresh: () => void;
  onToggleDetail: () => void;
}) {
  const { push } = useNavigation();

  async function markComplete() {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Erledigt…",
    });
    try {
      await client.completeTask(task.projectId, task.id);
      onRemove();
      toast.style = Toast.Style.Success;
      toast.title = "Erledigt";
      toast.message = task.title;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehler";
      toast.message = String(e);
    }
  }

  async function deleteTask() {
    const confirmed = await confirmAlert({
      title: "Aufgabe löschen?",
      message: task.title,
      primaryAction: { title: "Löschen", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Wird gelöscht…",
    });
    try {
      await client.deleteTask(task.projectId, task.id);
      onRemove();
      toast.style = Toast.Style.Success;
      toast.title = "Gelöscht";
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehler";
      toast.message = String(e);
    }
  }

  async function quickSetDue(yyyymmdd: string | null) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Fälligkeit setzen…",
    });
    try {
      const dueDate = yyyymmdd ?? null;
      await client.updateTask(task.id, { dueDate });
      onPatch({ dueDate, isAllDay: !!dueDate });
      toast.style = Toast.Style.Success;
      toast.title = dueDate
        ? `Fällig: ${formatDue(dueDate)}`
        : "Datum entfernt";
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehler";
      toast.message = String(e);
    }
  }

  async function quickSetPriority(priority: 0 | 1 | 3 | 5) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Priorität setzen…",
    });
    try {
      await client.updateTask(task.id, { priority });
      onPatch({ priority });
      toast.style = Toast.Style.Success;
      toast.title = `Priorität: ${priorityLabel(priority)}`;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehler";
      toast.message = String(e);
    }
  }

  async function quickMoveToProject(projectId: string) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Verschieben…",
    });
    try {
      await client.updateTask(task.id, { projectId });
      onPatch({ projectId });
      toast.style = Toast.Style.Success;
      toast.title = "Verschoben";
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehler";
      toast.message = String(e);
    }
  }

  return (
    <ActionPanel>
      <ActionPanel.Section>
        <Action
          title="Als Erledigt Markieren"
          icon={{ source: Icon.Checkmark, tintColor: Color.Green }}
          onAction={markComplete}
        />
        <Action
          title="Aufgabe Bearbeiten"
          icon={Icon.Pencil}
          shortcut={{ modifiers: ["cmd"], key: "e" }}
          onAction={() => push(<CreateTask task={task} onDone={onRefresh} />)}
        />
        <Action.OpenInBrowser
          title="In Ticktick Öffnen"
          url={`https://ticktick.com/webapp/#q/today/tasks/${task.id}`}
          shortcut={{ modifiers: ["cmd"], key: "return" }}
        />
      </ActionPanel.Section>
      <ActionPanel.Section title="Fälligkeit">
        <Action
          title="Morgen"
          icon={Icon.ArrowRight}
          shortcut={{ modifiers: ["cmd"], key: "t" }}
          onAction={() => quickSetDue(daysFromNow(1))}
        />
        <Action
          title="Nächste Woche"
          icon={Icon.Clock}
          shortcut={{ modifiers: ["cmd"], key: "s" }}
          onAction={() => quickSetDue(daysFromNow(7))}
        />
        <ActionPanel.Submenu
          title="Fälligkeit Ändern"
          icon={Icon.Calendar}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
        >
          <Action
            title="Heute"
            icon={Icon.Circle}
            onAction={() => quickSetDue(today())}
          />
          <Action
            title="Wochenende (sa)"
            icon={Icon.Calendar}
            onAction={() => quickSetDue(nextSaturday())}
          />
          <Action
            title="Kein Datum"
            icon={Icon.Minus}
            onAction={() => quickSetDue(null)}
          />
        </ActionPanel.Submenu>
      </ActionPanel.Section>
      <ActionPanel.Section>
        <ActionPanel.Submenu
          title="Priorität Ändern"
          icon={Icon.Flag}
          shortcut={{ modifiers: ["cmd"], key: "u" }}
        >
          <Action
            title="Hoch"
            icon={{ source: Icon.Circle, tintColor: Color.Red }}
            onAction={() => quickSetPriority(5)}
          />
          <Action
            title="Mittel"
            icon={{ source: Icon.Circle, tintColor: Color.Orange }}
            onAction={() => quickSetPriority(3)}
          />
          <Action
            title="Niedrig"
            icon={{ source: Icon.Circle, tintColor: Color.Blue }}
            onAction={() => quickSetPriority(1)}
          />
          <Action
            title="Keine"
            icon={{ source: Icon.Circle, tintColor: Color.SecondaryText }}
            onAction={() => quickSetPriority(0)}
          />
        </ActionPanel.Submenu>
        <ActionPanel.Submenu
          title="Projekt Wechseln"
          icon={Icon.List}
          shortcut={{ modifiers: ["cmd"], key: "m" }}
        >
          {projects
            .filter((p) => p.id !== task.projectId)
            .map((p) => (
              <Action
                key={p.id}
                title={p.name}
                onAction={() => quickMoveToProject(p.id)}
              />
            ))}
        </ActionPanel.Submenu>
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title="Neue Aufgabe"
          icon={Icon.Plus}
          shortcut={{ modifiers: ["cmd"], key: "n" }}
          onAction={() => push(<QuickAdd />)}
        />
        <Action
          title="Aktualisieren"
          icon={Icon.ArrowClockwise}
          shortcut={{ modifiers: ["cmd"], key: "r" }}
          onAction={onRefresh}
        />
        <Action
          title="Detail-Ansicht Umschalten"
          icon={Icon.Sidebar}
          shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
          onAction={onToggleDetail}
        />
        <Action
          title="Shortcuts Anzeigen"
          icon={Icon.QuestionMark}
          shortcut={{ modifiers: ["cmd"], key: "h" }}
          onAction={() => push(<ShortcutsHelp />)}
        />
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title="Aufgabe Löschen"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={{ modifiers: ["ctrl"], key: "x" }}
          onAction={deleteTask}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

// ─── Task Item ────────────────────────────────────────────────────────────────

function taskDetailMarkdown(task: TickTickTask): string {
  const parts: string[] = [`# ${task.title}`];
  if (task.content?.trim()) parts.push(`\n${task.content.trim()}`);
  return parts.join("\n");
}

function TaskItem({
  task,
  project,
  projects,
  onPatch,
  onRemove,
  onRefresh,
  onToggleDetail,
}: {
  task: TickTickTask;
  project: TickTickProject | undefined;
  projects: TickTickProject[];
  onPatch: (changes: Partial<TickTickTask>) => void;
  onRemove: () => void;
  onRefresh: () => void;
  onToggleDetail: () => void;
}) {
  const due = formatDue(task.dueDate);
  const projectInitial = project ? ([...project.name][0] ?? "?") : null;

  const accessories: List.Item.Accessory[] = [
    { tag: { value: due ?? " ", color: priorityColor(task.priority) } },
  ];

  const icon =
    projectInitial !== null ? projectInitial : priorityIcon(task.priority);

  return (
    <List.Item
      icon={icon}
      title={task.title}
      accessories={accessories}
      detail={
        <List.Item.Detail
          markdown={taskDetailMarkdown(task)}
          metadata={
            <List.Item.Detail.Metadata>
              {project && (
                <List.Item.Detail.Metadata.Label
                  title="Projekt"
                  text={project.name}
                  icon={Icon.List}
                />
              )}
              <List.Item.Detail.Metadata.Label
                title="Priorität"
                text={priorityLabel(task.priority)}
                icon={priorityIcon(task.priority)}
              />
              {due && (
                <List.Item.Detail.Metadata.Label
                  title="Fälligkeit"
                  text={due}
                  icon={{
                    source: Icon.Calendar,
                    tintColor: dueDateColor(task.dueDate),
                  }}
                />
              )}
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <TaskActions
          task={task}
          projects={projects}
          onPatch={onPatch}
          onRemove={onRemove}
          onRefresh={onRefresh}
          onToggleDetail={onToggleDetail}
        />
      }
    />
  );
}

// ─── Main Command ─────────────────────────────────────────────────────────────

type CachedData = { projects: TickTickProject[]; tasks: TickTickTask[] };

const SHOW_DETAIL_KEY = "my-tasks-show-detail";

export default function MyTasks() {
  const { push } = useNavigation();
  const [filter, setFilter] = useState<string>("all");
  const [searchText, setSearchText] = useState("");
  // Off by default, persisted: at the 900×570 window with a 220pt list
  // column, the detail pane leaves too little room for the list itself
  // unless the user opts in.
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    LocalStorage.getItem<boolean>(SHOW_DETAIL_KEY).then((value) => {
      if (value !== undefined) setShowDetail(value);
    });
  }, []);

  function toggleDetail() {
    setShowDetail((prev) => {
      const next = !prev;
      LocalStorage.setItem(SHOW_DETAIL_KEY, next);
      return next;
    });
  }

  const { data, isLoading, error, revalidate, mutate } = useCachedPromise(
    () =>
      stamped(async (): Promise<CachedData> => {
        const { projects, tasks } = await loadOpenTasks();
        return { projects, tasks: sortTasks(tasks) };
      }),
    [],
    { keepPreviousData: true, onError: () => {} },
  );

  const projects = data?.data.projects ?? [];
  const projectTasks = data?.data.tasks ?? [];

  const projectMap = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects],
  );

  const searchQuery = useMemo(() => parseSearch(searchText), [searchText]);

  const displayTasks = useMemo(() => {
    const filtered = applyFilter(projectTasks, filter);
    return applySearch(filtered, searchQuery, projectMap);
  }, [projectTasks, filter, searchQuery, projectMap]);

  const showGrouped = filter === "all" && !searchText.trim();

  const grouped = useMemo<Map<DueBucket, TickTickTask[]> | null>(() => {
    if (!showGrouped) return null;
    const map = new Map<DueBucket, TickTickTask[]>(
      BUCKET_ORDER.map((b) => [b, []]),
    );
    for (const task of displayTasks)
      map.get(dueBucket(task.dueDate))!.push(task);
    return map;
  }, [displayTasks, showGrouped]);

  function patchTask(taskId: string, changes: Partial<TickTickTask>) {
    mutate(undefined, {
      optimisticUpdate: (current): Stamped<CachedData> => {
        const stampedCurrent = current as Stamped<CachedData> | undefined;
        const safe = stampedCurrent?.data ?? { projects: [], tasks: [] };
        return {
          fetchedAt: stampedCurrent?.fetchedAt ?? Date.now(),
          data: {
            ...safe,
            tasks: sortTasks(
              safe.tasks.map((t) =>
                t.id === taskId ? { ...t, ...changes } : t,
              ),
            ),
          },
        };
      },
      shouldRevalidateAfter: false,
    });
  }

  function removeTask(taskId: string) {
    mutate(undefined, {
      optimisticUpdate: (current): Stamped<CachedData> => {
        const stampedCurrent = current as Stamped<CachedData> | undefined;
        const safe = stampedCurrent?.data ?? { projects: [], tasks: [] };
        return {
          fetchedAt: stampedCurrent?.fetchedAt ?? Date.now(),
          data: { ...safe, tasks: safe.tasks.filter((t) => t.id !== taskId) },
        };
      },
      shouldRevalidateAfter: false,
    });
  }

  function renderTask(task: TickTickTask) {
    return (
      <TaskItem
        key={task.id}
        task={task}
        project={projectMap[task.projectId]}
        projects={projects}
        onPatch={(changes) => patchTask(task.id, changes)}
        onRemove={() => removeTask(task.id)}
        onRefresh={revalidate}
        onToggleDetail={toggleDetail}
      />
    );
  }

  const offlineSuffix =
    error && data ? ` · offline, from ${formatAge(data.fetchedAt)}` : "";

  return (
    <List
      navigationTitle={`Tasks${offlineSuffix}`}
      isLoading={isLoading}
      isShowingDetail={showDetail}
      filtering={false}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Suchen… #Projekt !h/m/l heute morgen"
      searchBarAccessory={
        <List.Dropdown tooltip="Filter" value={filter} onChange={setFilter}>
          <List.Dropdown.Section title="Ansicht">
            <List.Dropdown.Item
              value="all"
              title="Alle offen"
              icon={Icon.Circle}
            />
          </List.Dropdown.Section>
          <List.Dropdown.Section title="Fälligkeit">
            <List.Dropdown.Item value="today" title="Heute" icon={Icon.Clock} />
            <List.Dropdown.Item
              value="overdue"
              title="Überfällig"
              icon={Icon.ExclamationMark}
            />
            <List.Dropdown.Item
              value="tomorrow"
              title="Morgen"
              icon={Icon.ArrowRight}
            />
            <List.Dropdown.Item
              value="week"
              title="Diese Woche"
              icon={Icon.Calendar}
            />
            <List.Dropdown.Item
              value="weekend"
              title="Wochenende"
              icon={Icon.Calendar}
            />
            <List.Dropdown.Item
              value="no-date"
              title="Kein Datum"
              icon={Icon.Minus}
            />
          </List.Dropdown.Section>
          <List.Dropdown.Section title="Priorität">
            <List.Dropdown.Item
              value="high"
              title="Hoch"
              icon={{ source: Icon.Circle, tintColor: Color.Red }}
            />
            <List.Dropdown.Item
              value="medium"
              title="Mittel"
              icon={{ source: Icon.Circle, tintColor: Color.Orange }}
            />
            <List.Dropdown.Item
              value="low"
              title="Niedrig"
              icon={{ source: Icon.Circle, tintColor: Color.Blue }}
            />
            <List.Dropdown.Item
              value="none"
              title="Keine Priorität"
              icon={{ source: Icon.Circle, tintColor: Color.SecondaryText }}
            />
          </List.Dropdown.Section>
          {projects.length > 0 && (
            <List.Dropdown.Section title="Projekt">
              {projects.map((p) => (
                <List.Dropdown.Item
                  key={p.id}
                  value={`project:${p.id}`}
                  title={p.name}
                  icon={[...p.name][0] ?? "📁"}
                />
              ))}
            </List.Dropdown.Section>
          )}
        </List.Dropdown>
      }
    >
      {grouped
        ? BUCKET_ORDER.map((bucket) => {
            const bucketTasks = grouped.get(bucket) ?? [];
            if (bucketTasks.length === 0) return null;
            return (
              <List.Section
                key={bucket}
                title={BUCKET_TITLE[bucket]}
                subtitle={`${bucketTasks.length}`}
              >
                {bucketTasks.map(renderTask)}
              </List.Section>
            );
          })
        : displayTasks.map(renderTask)}

      {!isLoading && displayTasks.length === 0 && (
        <List.EmptyView
          icon={Icon.Checkmark}
          title="Keine Aufgaben"
          description="⌘N für neue Aufgabe."
          actions={
            <ActionPanel>
              <Action
                title="Neue Aufgabe"
                icon={Icon.Plus}
                shortcut={{ modifiers: ["cmd"], key: "n" }}
                onAction={() => push(<QuickAdd />)}
              />
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}
