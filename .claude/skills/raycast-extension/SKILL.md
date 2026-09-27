---
name: raycast-extension
description: Raycast extension development reference — command modes, UI components, hooks, APIs, and patterns for building the TickTick extension
agent: general-purpose
---

# Raycast Extension Reference

Raycast extensions are TypeScript + React apps. The `@raycast/api` package provides all UI primitives; `@raycast/utils` provides hooks and utilities.

Docs: https://developers.raycast.com
Inspiration: https://github.com/raycast/extensions/tree/main/extensions/todoist
             https://github.com/raycast/extensions/tree/main/extensions/linear

---

## Command Modes

Declared in `package.json` per command:

| Mode | `"mode"` value | Use case |
|-|-|-|
| View | `"view"` | Interactive UI — List, Grid, Detail, Form |
| No-view | `"no-view"` | Background action → HUD or Toast feedback |
| Menu bar | `"menu-bar"` | Persistent menu bar item with dropdown |

---

## UI Components

### List — primary workhorse

```tsx
<List
  isLoading={isLoading}
  filtering={false}                       // disable built-in filter if using server-side
  searchBarPlaceholder="Search tasks..."
  searchBarAccessory={
    <List.Dropdown tooltip="Filter" onChange={setFilter}>
      <List.Dropdown.Section title="Status">
        <List.Dropdown.Item value="all" title="All Open" />
        <List.Dropdown.Item value="today" title="Due Today" />
        <List.Dropdown.Item value="overdue" title="Overdue" />
      </List.Dropdown.Section>
      <List.Dropdown.Section title="Priority">
        <List.Dropdown.Item value="urgent" title="Urgent" />
      </List.Dropdown.Section>
    </List.Dropdown>
  }
>
  <List.Section title="Overdue" subtitle={`${count} tasks`}>
    <List.Item
      key={task.id}
      icon={{ source: Icon.Circle, tintColor: Color.Red }}
      title={task.title}
      subtitle="Project Name"
      accessories={[
        { tag: { value: "urgent", color: Color.Red } },
        { icon: { source: Icon.Person, tintColor: Color.Blue }, tooltip: "Assigned to you" },
        { text: { value: "Tomorrow", color: Color.Orange }, icon: Icon.Calendar },
        { date: new Date(task.due_date!), tooltip: "Due date" },
      ]}
      actions={<ActionPanel>...</ActionPanel>}
    />
  </List.Section>
  <List.EmptyView
    icon={Icon.Checkmark}
    title="All clear"
    description="Press ⌘N to add a task."
  />
</List>
```

Accessory types: `tag`, `text`, `icon`, `date`, `icon+text`, `icon+date` — all support `tooltip`.

### Detail — task detail with markdown

```tsx
<Detail
  markdown={`# ${task.title}\n\n${task.description ?? "_No description_"}`}
  metadata={
    <Detail.Metadata>
      <Detail.Metadata.Label title="Priority" text="High" icon={Icon.ArrowUp} />
      <Detail.Metadata.TagList title="Labels">
        {task.labels.map(l => (
          <Detail.Metadata.TagList.Item key={l.id} text={l.title} color={`#${l.hex_color}`} />
        ))}
      </Detail.Metadata.TagList>
      <Detail.Metadata.Label title="Due" text={formatDueDate(task.due_date)} />
      <Detail.Metadata.Separator />
      <Detail.Metadata.Link
        title="Open in Vikunja"
        target={`https://vikunja.jkrumm.com/tasks/${task.id}`}
        text={task.identifier}
      />
    </Detail.Metadata>
  }
  actions={<ActionPanel>...</ActionPanel>}
/>
```

### Form — create / edit tasks

```tsx
<Form
  isLoading={isSubmitting}
  actions={
    <ActionPanel>
      <Action.SubmitForm title="Create Task" onSubmit={handleSubmit} />
    </ActionPanel>
  }
>
  <Form.TextField id="title" title="Title" placeholder="Task title" autoFocus />
  <Form.TextArea id="description" title="Description" enableMarkdown />
  <Form.Dropdown id="project_id" title="Project">
    {projects.map(p => <Form.Dropdown.Item key={p.id} value={String(p.id)} title={p.title} />)}
  </Form.Dropdown>
  <Form.Dropdown id="priority" title="Priority" defaultValue="0">
    <Form.Dropdown.Item value="0" title="No priority" />
    <Form.Dropdown.Item value="1" title="Low" />
    <Form.Dropdown.Item value="2" title="Medium" />
    <Form.Dropdown.Item value="3" title="High" />
    <Form.Dropdown.Item value="5" title="Urgent" />
  </Form.Dropdown>
  <Form.TagPicker id="labels" title="Labels">
    {labels.map(l => <Form.TagPicker.Item key={l.id} value={String(l.id)} title={l.title} />)}
  </Form.TagPicker>
  <Form.DatePicker id="due_date" title="Due Date" type={Form.DatePicker.Type.Date} />
  <Form.Checkbox id="is_favorite" label="Mark as favorite" />
</Form>
```

### Grid — project cards with cover images

```tsx
<Grid columns={3} aspectRatio="4/3" filtering>
  <Grid.Item
    content={project.background_image ?? Icon.List}
    title={project.title}
    actions={<ActionPanel>...</ActionPanel>}
  />
</Grid>
```

### MenuBarExtra — menu bar command

```tsx
// package.json: "mode": "menu-bar"
export default function MenuBarTasks() {
  const overdueCount = tasks.filter(t => isOverdue(t.due_date)).length;
  return (
    <MenuBarExtra
      icon={overdueCount > 0 ? { source: Icon.ExclamationMark, tintColor: Color.Red } : Icon.CheckCircle}
      title={overdueCount > 0 ? String(overdueCount) : undefined}
      tooltip="Vikunja Tasks"
    >
      <MenuBarExtra.Section title="Overdue">
        {overdueTasks.map(t => (
          <MenuBarExtra.Item
            key={t.id}
            title={t.title}
            icon={{ source: Icon.Circle, tintColor: Color.Red }}
            onAction={() => open(`https://vikunja.jkrumm.com/tasks/${t.id}`)}
          />
        ))}
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
```

### ActionPanel — all actions and shortcuts

```tsx
<ActionPanel>
  <ActionPanel.Section>
    <Action
      title="Mark Done"
      icon={{ source: Icon.Checkmark, tintColor: Color.Green }}
      shortcut={{ modifiers: ["cmd"], key: "d" }}
      onAction={() => markDone(task)}
    />
    <Action.Push
      title="View Detail"
      icon={Icon.Eye}
      target={<TaskDetail task={task} />}
    />
    <Action.Push
      title="Edit Task"
      icon={Icon.Pencil}
      shortcut={{ modifiers: ["cmd"], key: "e" }}
      target={<EditTask task={task} onUpdated={revalidate} />}
    />
  </ActionPanel.Section>
  <ActionPanel.Section>
    <Action
      title="Toggle Favorite"
      icon={task.is_favorite ? Icon.StarDisabled : Icon.Star}
      shortcut={{ modifiers: ["cmd"], key: "f" }}
      onAction={() => toggleFavorite(task)}
    />
    <Action.OpenInBrowser
      title="Open in Vikunja"
      url={`https://vikunja.jkrumm.com/tasks/${task.id}`}
      shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
    />
    <Action.CopyToClipboard
      title="Copy Link"
      content={`https://vikunja.jkrumm.com/tasks/${task.id}`}
      shortcut={{ modifiers: ["cmd", "opt"], key: "c" }}
    />
  </ActionPanel.Section>
  <ActionPanel.Section>
    <Action
      title="Delete Task"
      icon={Icon.Trash}
      style={Action.Style.Destructive}
      shortcut={{ modifiers: ["ctrl"], key: "x" }}
      onAction={() => deleteTask(task)}
    />
  </ActionPanel.Section>
</ActionPanel>
```

---

## Hooks & APIs

### Extension Preferences

```json
// package.json (extension-level, not per-command)
"preferences": [
  {
    "name": "apiToken",
    "title": "API Token",
    "description": "Vikunja bearer token from vikunja.jkrumm.com",
    "type": "password",
    "required": true
  },
  {
    "name": "baseUrl",
    "title": "Vikunja URL",
    "type": "textfield",
    "default": "https://vikunja.jkrumm.com",
    "required": true
  },
  {
    "name": "defaultProjectId",
    "title": "Default Project (for Quick Add)",
    "type": "textfield",
    "required": false
  }
]
```

```typescript
const { apiToken, baseUrl, defaultProjectId } = getPreferenceValues<Preferences>();
```

### useFetch (@raycast/utils) — data fetching with cache

```typescript
const { data: tasks, isLoading, revalidate } = useFetch<VikunjaTask[]>(
  `${baseUrl}/api/v1/tasks?filter=${encodeURIComponent(FILTERS[filter])}&sort_by=due_date&expand=labels,assignees`,
  {
    headers: { Authorization: `Bearer ${apiToken}` },
    keepPreviousData: true,   // no flash between filter changes
    initialData: [],
    onError: (err) => showToast({ style: Toast.Style.Failure, title: "Failed to load", message: err.message }),
  }
);
```

### useLocalStorage / useCachedState (@raycast/utils)

```typescript
// Persists across launches
const [lastFilter, setLastFilter] = useLocalStorage("vikunja-last-filter", "all");

// Memory cache (cleared on quit)
const [projects, setProjects] = useCachedState<Project[]>("vikunja-projects", []);
```

### Toast — operation feedback

```typescript
const toast = await showToast({ style: Toast.Style.Animated, title: "Creating task..." });
try {
  await createTask(data);
  toast.style = Toast.Style.Success;
  toast.title = "Task created";
  toast.message = data.title;
} catch (e) {
  toast.style = Toast.Style.Failure;
  toast.title = "Failed";
  toast.message = String(e);
}
```

### HUD — no-view command feedback

```typescript
// After no-view action completes
await showHUD("✓ Task marked done");
await closeMainWindow();
```

### Clipboard

```typescript
await Clipboard.copy(`https://vikunja.jkrumm.com/tasks/${task.id}`);
await showHUD("Link copied");
```

### AI (Raycast Pro) — natural language parsing

```typescript
import { AI, environment } from "@raycast/api";

if (environment.canAccess(AI)) {
  const json = await AI.ask(
    `Parse this task into JSON with fields: title (string), priority (0-5), due_date (ISO or null), label_names (string[]).
     Input: "${input}"
     Return only valid JSON, no markdown.`,
    { model: AI.Model.OpenAI_GPT4o_mini, creativity: 0 }
  );
  const parsed = JSON.parse(json);
}
```

### confirmAlert — destructive confirmations

```typescript
const confirmed = await confirmAlert({
  title: "Delete Task?",
  message: task.title,
  primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
});
if (confirmed) await deleteTask(task.id);
```

### Deeplinks — link to specific commands/tasks

```
raycast://extensions/jkrumm/vikunja/my-tasks
raycast://extensions/jkrumm/vikunja/create-task?arguments={"title":"Buy milk"}
```

### Command Arguments — typed URL params

```json
// package.json command entry
"arguments": [
  { "name": "title", "placeholder": "Task title", "type": "text", "required": false }
]
```

```typescript
export default function QuickAdd({ arguments: { title } }: LaunchProps<{ arguments: { title: string } }>) {
```

---

## Keyboard Shortcut Conventions

```
Enter         → primary action (open detail / mark done)
⌘ + D         → mark done
⌘ + E         → edit
⌘ + N         → new task
⌘ + R         → refresh
⌘ + F         → toggle favorite
⌘ + ⇧ + O    → open in browser
⌘ + ⌥ + C    → copy link
ctrl + X      → delete (destructive — less reachable on purpose)
```

---

## Patterns

### Optimistic UI

```typescript
// Update locally first, sync API, revert on failure
setTasks(prev => prev.map(t => t.id === id ? { ...t, done: true } : t));
try {
  await api(`/tasks/${id}`, { method: "POST", body: JSON.stringify({ done: true }) });
  await showToast({ style: Toast.Style.Success, title: "Done", message: task.title });
} catch {
  setTasks(prev => prev.map(t => t.id === id ? { ...t, done: false } : t));
  await showToast({ style: Toast.Style.Failure, title: "Failed to update" });
}
```

### Section grouping

Group tasks by: project, due date bucket (overdue / today / this week / later), priority tier, or label.

```typescript
const sections = {
  overdue:   tasks.filter(t => t.due_date && t.due_date < today()),
  today:     tasks.filter(t => t.due_date === today()),
  thisWeek:  tasks.filter(t => t.due_date > today() && t.due_date <= nextWeek()),
  later:     tasks.filter(t => !t.due_date || t.due_date > nextWeek()),
};
```

### Navigation stack

```tsx
// Push detail view from list
<Action.Push title="View" target={<TaskDetail task={task} onUpdated={revalidate} />} />

// Pop back after form submit
const { pop } = useNavigation();
// ... after successful create:
pop();
revalidate();
```
