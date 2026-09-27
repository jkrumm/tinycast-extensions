export interface TickTickProject {
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

export interface TickTickChecklistItem {
  id: string;
  title: string;
  status: 0 | 2;
  sortOrder: number;
  startDate: string | null;
  isAllDay: boolean;
  timeZone: string;
  completedTime: string | null;
}

export interface TickTickTask {
  id: string;
  projectId: string;
  title: string;
  content: string;
  desc: string;
  isAllDay: boolean;
  isFloating: boolean;
  startDate: string | null;
  dueDate: string | null;
  completedTime: string | null;
  timeZone: string;
  reminders?: string[];
  repeatFlag: string | null;
  priority: 0 | 1 | 3 | 5;
  status: 0 | 2;
  sortOrder: number;
  tags?: string[];
  items?: TickTickChecklistItem[];
  kind: "TEXT" | "CHECKLIST" | "NOTE";
}

export interface TickTickProjectData {
  project: TickTickProject;
  tasks: TickTickTask[];
  columns?: { id: string; name: string }[];
}

export interface CreateTaskInput {
  title: string;
  projectId?: string;
  dueDate?: string | null;
  isAllDay?: boolean;
  priority?: 0 | 1 | 3 | 5;
  content?: string;
  timeZone?: string;
}
