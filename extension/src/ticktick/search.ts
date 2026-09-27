import { TickTickProject, TickTickTask } from "./types";
import {
  today,
  daysFromNow,
  taskDate,
  isOverdue,
  isDueToday,
  isDueTomorrow,
} from "./format";

export interface SearchQuery {
  text: string;
  projectFilter: string | null;
  priorityFilter: number | null;
  dateFilter:
    | "today"
    | "tomorrow"
    | "weekend"
    | "overdue"
    | "no-date"
    | "week"
    | null;
}

export function parseSearch(raw: string): SearchQuery {
  let text = raw.trim();
  let projectFilter: string | null = null;
  let priorityFilter: number | null = null;
  let dateFilter: SearchQuery["dateFilter"] = null;

  // #project — substring match against project names
  const projectMatch = text.match(/#(\S+)/);
  if (projectMatch) {
    projectFilter = projectMatch[1].toLowerCase();
    text = text.replace(/#\S+/, "").trim();
  }

  // !priority — !h/hoch, !m/mittel, !l/niedrig, !n/keine
  const prioMatch = text.match(/!(\S+)/);
  if (prioMatch) {
    const p = prioMatch[1].toLowerCase();
    if (p === "h" || p === "hoch" || p === "high") priorityFilter = 5;
    else if (p === "m" || p === "mittel" || p === "medium") priorityFilter = 3;
    else if (p === "l" || p === "niedrig" || p === "low") priorityFilter = 1;
    else if (p === "n" || p === "keine" || p === "none") priorityFilter = 0;
    text = text.replace(/!\S+/, "").trim();
  }

  // Date keywords — only match when remaining text is exactly the keyword
  const lower = text.toLowerCase();
  const dateKeywords: [string[], SearchQuery["dateFilter"]][] = [
    [["heute", "today"], "today"],
    [["morgen", "tomorrow"], "tomorrow"],
    [["wochenende", "weekend"], "weekend"],
    [["überfällig", "overdue"], "overdue"],
    [["kein datum", "kein-datum", "no date", "no-date"], "no-date"],
    [["woche", "week"], "week"],
  ];

  for (const [keywords, bucket] of dateKeywords) {
    if (keywords.some((k) => lower === k)) {
      dateFilter = bucket;
      text = "";
      break;
    }
  }

  return { text, projectFilter, priorityFilter, dateFilter };
}

export function applySearch(
  tasks: TickTickTask[],
  query: SearchQuery,
  projectMap: Record<string, TickTickProject>,
): TickTickTask[] {
  let result = tasks;

  if (query.projectFilter) {
    const pf = query.projectFilter;
    result = result.filter((t) =>
      projectMap[t.projectId]?.name.toLowerCase().includes(pf),
    );
  }

  if (query.priorityFilter !== null) {
    result = result.filter((t) => t.priority === query.priorityFilter);
  }

  if (query.dateFilter) {
    const todayStr = today();
    switch (query.dateFilter) {
      case "today":
        result = result.filter((t) => isDueToday(t.dueDate));
        break;
      case "tomorrow":
        result = result.filter((t) => isDueTomorrow(t.dueDate));
        break;
      case "overdue":
        result = result.filter((t) => isOverdue(t.dueDate));
        break;
      case "no-date":
        result = result.filter((t) => !t.dueDate);
        break;
      case "weekend":
        result = result.filter((t) => {
          if (!t.dueDate) return false;
          const d = taskDate(t.dueDate);
          if (d < todayStr) return false;
          const day = new Date(d + "T12:00:00").getDay();
          return day === 0 || day === 6;
        });
        break;
      case "week": {
        const end = daysFromNow(7);
        result = result.filter(
          (t) =>
            !!t.dueDate &&
            taskDate(t.dueDate) >= todayStr &&
            taskDate(t.dueDate) <= end,
        );
        break;
      }
    }
  }

  if (query.text) {
    const lower = query.text.toLowerCase();
    result = result.filter(
      (t) =>
        t.title.toLowerCase().includes(lower) ||
        (t.content?.toLowerCase() ?? "").includes(lower),
    );
  }

  return result;
}
