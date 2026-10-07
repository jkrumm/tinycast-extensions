import { LocalStorage } from "@raycast/api";
import { SpeedTestRecord } from "./types";

const HISTORY_KEY = "speed-test-history";

// A pre-fix bug (see parse.ts) could persist a record with dlMbps: null when
// a full test ran while offline — that record self-heals out of history on
// the next load rather than crashing every render forever.
function isValidRecord(record: unknown): record is SpeedTestRecord {
  return (
    typeof record === "object" &&
    record !== null &&
    Number.isFinite((record as SpeedTestRecord).dlMbps)
  );
}

export async function loadHistory(): Promise<SpeedTestRecord[]> {
  const raw = await LocalStorage.getItem<string>(HISTORY_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter(isValidRecord) : [];
}

export async function saveHistory(history: SpeedTestRecord[]): Promise<void> {
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}
