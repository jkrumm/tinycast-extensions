// Stale-while-revalidate honesty. `useCachedPromise` paints the last cached
// result instantly, but Tinycast has no loading chrome for Detail/List/Grid
// (see the tinycast skill), so without an explicit line a failed refresh
// leaves days-old data looking live. Loaders return `Stamped<T>` and every
// cached view renders `freshnessBanner`/`updatingLine` from it.
// Pure — no @raycast/api import.

export interface Stamped<T> {
  data: T;
  fetchedAt: number; // epoch ms of the fetch that produced `data`
}

export async function stamped<T>(load: () => Promise<T>): Promise<Stamped<T>> {
  const data = await load();
  return { data, fetchedAt: Date.now() };
}

export function formatAge(fetchedAt: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - fetchedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// Top-of-view warning when the latest refresh failed and cached data is
// shown instead. Null when the data is live.
export function freshnessBanner(opts: {
  fetchedAt: number | undefined;
  error: unknown;
  offlineLabel?: string; // e.g. "Router not reachable"
  now?: number;
}): string | null {
  const { fetchedAt, error, offlineLabel = "Offline", now } = opts;
  if (!error || fetchedAt === undefined) return null;
  return `> ⚠️ **${offlineLabel}** — showing the last known state from ${formatAge(fetchedAt, now)}.`;
}

// Bottom-of-view hint while a refresh runs over cached data — last line, so
// block order (and the decoded hero images above) stays stable.
export function updatingLine(opts: {
  fetchedAt: number | undefined;
  isLoading: boolean;
  now?: number;
}): string | null {
  const { fetchedAt, isLoading, now } = opts;
  if (!isLoading || fetchedAt === undefined) return null;
  return `_Updating… (shown: ${formatAge(fetchedAt, now)})_`;
}
