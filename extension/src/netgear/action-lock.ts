// Cross-process action lock so the watchdog background command and the
// Netgear UI never mutate the router at the same time (a connect from one
// while the other is mid-disconnect is what made "Reconnect" fail with "Router
// rejected the request"). A plain JSON file created with `openSync(path, "wx")` —
// the exclusive create is the mutual exclusion — holding who owns it and
// until when. A lock past `expiresAt` (its owner was killed mid-action) or an
// unparseable file counts as free. Node `fs/promises` only, no `@raycast/api`,
// so it runs under vitest against a tmp dir; session.ts supplies the real
// path (`actionLockPath()`).

// Only fs functions Tinycast's node shim actually implements (its
// `fs/promises` has no `open` — that crashed every watchdog tick and every
// manual action on 2026-10-01): sync `openSync(…, "wx")` is O_EXCL there.
import { closeSync, existsSync, openSync, writeSync } from "fs";
import { readFile, rm, writeFile } from "fs/promises";

export type ActionLockOwner = "watchdog" | "ui";

export interface ActionLockHolder {
  owner: ActionLockOwner;
  label: string;
  at: number; // epoch ms the lock was taken
  expiresAt: number; // epoch ms after which it counts as free
}

export interface ActionLock extends ActionLockHolder {
  // Deletes the lock file only if it is still this lock — never one a later
  // owner took over.
  release(): Promise<void>;
}

type Sleep = (ms: number) => Promise<void>;
type Now = () => number;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
const defaultNow: Now = () => Date.now();

export interface TryAcquireOptions {
  path: string;
  owner: ActionLockOwner;
  label: string;
  ttlMs: number;
  now?: Now;
}

function isHolder(value: unknown): value is ActionLockHolder {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.owner === "watchdog" || v.owner === "ui") &&
    typeof v.label === "string" &&
    typeof v.at === "number" &&
    typeof v.expiresAt === "number"
  );
}

async function readFileHolder(path: string): Promise<ActionLockHolder | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isHolder(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The current, unexpired holder — null when the lock is free (no file,
// unparseable file, or expired).
export async function readActionLock(
  path: string,
  now: Now = defaultNow,
): Promise<ActionLockHolder | null> {
  const holder = await readFileHolder(path);
  if (!holder || now() > holder.expiresAt) return null;
  return holder;
}

function makeLock(path: string, holder: ActionLockHolder): ActionLock {
  return {
    ...holder,
    release: async () => {
      const current = await readFileHolder(path);
      if (
        current &&
        current.owner === holder.owner &&
        current.at === holder.at &&
        current.expiresAt === holder.expiresAt
      ) {
        await rm(path, { force: true });
      }
    },
  };
}

function newHolder(opts: TryAcquireOptions): ActionLockHolder {
  const at = (opts.now ?? defaultNow)();
  return {
    owner: opts.owner,
    label: opts.label,
    at,
    expiresAt: at + opts.ttlMs,
  };
}

// Takes the lock if it is free (or stale), else returns null — never waits.
export async function tryAcquireActionLock(
  opts: TryAcquireOptions,
): Promise<ActionLock | null> {
  const { path, now = defaultNow } = opts;
  // Two passes: the second only runs after clearing a stale/unparseable file.
  for (let attempt = 0; attempt < 2; attempt++) {
    const holder = newHolder(opts);
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, Buffer.from(JSON.stringify(holder)));
      } finally {
        closeSync(fd);
      }
      return makeLock(path, holder);
    } catch (e) {
      // Tinycast's host bridge may not set `code: "EEXIST"`, so "the file is
      // already there" is checked directly rather than trusted from the error.
      if (!existsSync(path)) throw e;
    }
    if (await readActionLock(path, now)) return null;
    await rm(path, { force: true });
  }
  return null;
}

export interface AcquireOptions extends TryAcquireOptions {
  // How long to wait for a foreign lock to clear before taking over anyway —
  // the user's explicit action wins over a stuck or slow background run.
  waitMs: number;
  pollMs: number;
  sleep?: Sleep;
  // Called once, with the first foreign holder seen.
  onWait?: (holder: ActionLockHolder) => void;
}

export async function acquireActionLock(
  opts: AcquireOptions,
): Promise<ActionLock> {
  const {
    path,
    waitMs,
    pollMs,
    sleep = defaultSleep,
    now = defaultNow,
    onWait,
  } = opts;
  const deadline = now() + waitMs;
  let notified = false;
  for (;;) {
    const lock = await tryAcquireActionLock(opts);
    if (lock) return lock;
    if (!notified) {
      const holder = await readActionLock(path, now);
      if (holder) {
        notified = true;
        onWait?.(holder);
      }
    }
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  const holder = newHolder(opts);
  await writeFile(path, JSON.stringify(holder));
  return makeLock(path, holder);
}
