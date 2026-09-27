---
name: ticktick-api
description: HomeLab TickTick proxy API reference — endpoints, task model, auth, and code patterns for argo.jkrumm.com/api
agent: general-purpose
---

# TickTick HomeLab Proxy API Reference

The HomeLab proxy at `argo.jkrumm.com/api` absorbs TickTick OAuth2 complexity and exposes a simple Bearer-token API.

**Base URL:** `https://argo.jkrumm.com/api`
**Auth:** `Authorization: Bearer <token>` on every request (token configured in Raycast preferences)
**Health check:** `GET /api/ping`

---

## Client Pattern

```typescript
import { getPreferenceValues } from "@raycast/api";

const { apiToken, baseUrl } = getPreferenceValues<{ apiToken: string; baseUrl: string }>();

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
      ...(options?.headers as Record<string, string>),
    },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  return res.json() as Promise<T>;
}
```

---

## Data Models

```typescript
interface TickTickProject {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  closed: boolean | null;
  groupId: string | null;
  viewMode: "list" | "kanban" | "timeline" | null;
  permission: "read" | "write" | "comment" | null;
  kind: "TASK" | "NOTE";
}

interface TickTickTask {
  id: string;
  projectId: string;
  title: string;
  content: string;          // markdown body
  desc: string;             // checklist description
  isAllDay: boolean;
  isFloating: boolean;
  startDate: string | null; // "yyyy-MM-dd'T'HH:mm:ssZ"
  dueDate: string | null;   // "yyyy-MM-dd'T'HH:mm:ssZ"
  completedTime: string | null;
  timeZone: string;         // e.g. "Europe/Berlin"
  reminders: string[];      // e.g. ["TRIGGER:P0DT9H0M0S"]
  repeatFlag: string | null;// e.g. "RRULE:FREQ=DAILY;INTERVAL=1"
  priority: 0 | 1 | 3 | 5; // 0=None 1=Low 3=Medium 5=High
  status: 0 | 2;            // 0=Active 2=Completed
  sortOrder: number;
  tags: string[];
  items: TickTickChecklistItem[];
  kind: "TEXT" | "CHECKLIST" | "NOTE";
}

interface TickTickChecklistItem {
  id: string;
  title: string;
  status: 0 | 2;
  sortOrder: number;
  startDate: string | null;
  isAllDay: boolean;
  timeZone: string;
  completedTime: string | null;
}

interface TickTickProjectData {
  project: TickTickProject;
  tasks: TickTickTask[];
  columns?: { id: string; name: string }[];
}
```

---

## Endpoints

| Method | Path | Purpose |
|-|-|-|
| GET | `/ticktick/projects` | Get all projects → `TickTickProject[]` |
| GET | `/ticktick/projects/{projectId}/data` | Get project with tasks + columns → `TickTickProjectData` |
| POST | `/ticktick/tasks` | Create task → `TickTickTask` |
| POST | `/ticktick/tasks/{taskId}` | Update task (partial) → `TickTickTask` |
| POST | `/ticktick/projects/{projectId}/tasks/{taskId}/complete` | Mark task complete |
| DELETE | `/ticktick/projects/{projectId}/tasks/{taskId}` | Delete task |
| GET | `/api/ping` | Authenticated health check |

---

## Common Operations

```typescript
// List all projects
const projects = await api<TickTickProject[]>("/ticktick/projects");

// Get all tasks for a project (includes completed)
const data = await api<TickTickProjectData>(`/ticktick/projects/${projectId}/data`);
const activeTasks = data.tasks.filter(t => t.status === 0);

// Create a task
const task = await api<TickTickTask>("/ticktick/tasks", {
  method: "POST",
  body: JSON.stringify({
    title: "Fix login bug",
    projectId: "abc123",
    priority: 3,
    dueDate: "2026-03-01T00:00:00+0000",
    isAllDay: true,
    timeZone: "Europe/Berlin",
  }),
});

// Update a task
await api(`/ticktick/tasks/${taskId}`, {
  method: "POST",
  body: JSON.stringify({ title: "Updated title", priority: 5 }),
});

// Mark complete
await api(`/ticktick/projects/${projectId}/tasks/${taskId}/complete`, {
  method: "POST",
});

// Delete a task
await api(`/ticktick/projects/${projectId}/tasks/${taskId}`, {
  method: "DELETE",
});
```

---

## Priority Scale

| Value | Label |
|-|-|
| 0 | No priority |
| 1 | Low |
| 3 | Medium |
| 5 | High |

Note: TickTick uses 0/1/3/5 — there is no 2 or 4.

---

## CreateTask / UpdateTask Input Shape

```typescript
interface CreateTaskInput {
  title: string;
  projectId?: string;        // omit to use default inbox
  dueDate?: string | null;   // YYYY-MM-DD preferred (see Date Handling below)
  priority?: 0 | 1 | 3 | 5;
  content?: string;          // markdown notes
  timeZone?: string;         // default "Europe/Berlin" — used to compute midnight
}
```

---

## Date Handling (Critical)

The proxy normalizes dates server-side. **Clients should send `dueDate` as `YYYY-MM-DD`** (e.g. `"2026-03-11"`). The server:

1. Computes midnight in the task's `timeZone` (using `Intl` offset — works regardless of server TZ)
2. Formats as `"2026-03-10T23:00:00.000+0000"` (Berlin midnight for March 11)
3. Sets `startDate = dueDate` (TickTick requires both for all-day tasks to appear)
4. Sets `isAllDay: true`

**Why this matters — lessons learned:**
- TickTick requires **`startDate` = `dueDate`** — omitting `startDate` causes no date to appear
- Date must be **midnight in the task's timezone**, not midnight UTC
- Format must be `+0000` not `Z` (technically equivalent but TickTick is strict)
- Never compute the ISO string client-side — server/Mac timezone causes wrong results if user is abroad

**Example — what the proxy sends to TickTick for `dueDate: "2026-03-11"` + `timeZone: "Europe/Berlin"`:**
```json
{
  "dueDate": "2026-03-10T23:00:00.000+0000",
  "startDate": "2026-03-10T23:00:00.000+0000",
  "isAllDay": true,
  "timeZone": "Europe/Berlin"
}
```

**What TickTick returns for existing all-day tasks (for reference):**
```json
{
  "dueDate": "2026-03-10T23:00:00.000+0000",
  "startDate": "2026-03-10T23:00:00.000+0000",
  "isAllDay": true,
  "timeZone": "Europe/Berlin"
}
```

Reading dates back: use `toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" })` — never slice the first 10 chars of the ISO string, as the UTC date differs from the Berlin date.
