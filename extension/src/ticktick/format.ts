import { Color, Icon } from "@raycast/api";

export function today(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

export function daysFromNow(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

// Parse TickTick ISO date string into a YYYY-MM-DD string in Europe/Berlin timezone.
// TickTick stores all-day tasks as local-midnight UTC (e.g. a Berlin task due
// 2026-03-01 is sent as "2026-02-28T23:00:00.000+0000"), so we must convert to
// the local Berlin date before comparing — never just slice the first 10 chars.
export function taskDate(due: string): string {
  return new Date(due).toLocaleDateString("sv-SE", {
    timeZone: "Europe/Berlin",
  });
}

// Pass YYYY-MM-DD directly — the server normalizes to ISO midnight UTC and sets isAllDay.
export function toTickTickDate(yyyymmdd: string): string {
  return yyyymmdd;
}

// Next Saturday from today (returns today if already Saturday).
export function nextSaturday(): string {
  const d = new Date();
  const daysUntilSat = (6 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + daysUntilSat);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isOverdue(due: string | null): boolean {
  return !!due && taskDate(due) < today();
}

export function isDueToday(due: string | null): boolean {
  return !!due && taskDate(due) === today();
}

export function isDueTomorrow(due: string | null): boolean {
  return !!due && taskDate(due) === daysFromNow(1);
}

export function formatDue(due: string | null): string | null {
  if (!due) return null;
  const d = taskDate(due);
  const t = today();
  if (d < t) {
    const days = Math.round((Date.parse(t) - Date.parse(d)) / 86400000);
    return days === 1 ? "Gestern" : `${days}T. überfällig`;
  }
  if (d === t) return "Heute";
  if (d === daysFromNow(1)) return "Morgen";
  const diff = Math.round((Date.parse(d) - Date.parse(t)) / 86400000);
  if (diff <= 7)
    return new Date(d + "T12:00:00").toLocaleDateString("de-DE", {
      weekday: "short",
    });
  return new Date(d + "T12:00:00").toLocaleDateString("de-DE", {
    day: "numeric",
    month: "short",
  });
}

export function dueDateColor(due: string | null): Color {
  if (isOverdue(due)) return Color.Red;
  if (isDueToday(due)) return Color.Orange;
  return Color.SecondaryText;
}

// ─── Priority (TickTick scale: 0=None, 1=Low, 3=Medium, 5=High) ──────────────

export function priorityIcon(p: number): { source: Icon; tintColor: Color } {
  if (p >= 5) return { source: Icon.Circle, tintColor: Color.Red };
  if (p >= 3) return { source: Icon.Circle, tintColor: Color.Orange };
  if (p >= 1) return { source: Icon.Circle, tintColor: Color.Blue };
  return { source: Icon.Circle, tintColor: Color.SecondaryText };
}

export function priorityLabel(p: number): string {
  if (p >= 5) return "Hoch";
  if (p >= 3) return "Mittel";
  if (p >= 1) return "Niedrig";
  return "Keine";
}

export function priorityColor(p: number): Color {
  if (p >= 5) return Color.Red;
  if (p >= 3) return Color.Orange;
  if (p >= 1) return Color.Blue;
  return Color.SecondaryText;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

export type DueBucket =
  | "overdue"
  | "today"
  | "tomorrow"
  | "this-week"
  | "later"
  | "no-date";

export function dueBucket(due: string | null): DueBucket {
  if (!due) return "no-date";
  const d = taskDate(due);
  const t = today();
  if (d < t) return "overdue";
  if (d === t) return "today";
  if (d === daysFromNow(1)) return "tomorrow";
  if (d <= daysFromNow(7)) return "this-week";
  return "later";
}

export const BUCKET_TITLE: Record<DueBucket, string> = {
  overdue: "Überfällig",
  today: "Heute",
  tomorrow: "Morgen",
  "this-week": "Diese Woche",
  later: "Später",
  "no-date": "Kein Datum",
};

export const BUCKET_ORDER: DueBucket[] = [
  "overdue",
  "today",
  "tomorrow",
  "this-week",
  "later",
  "no-date",
];
