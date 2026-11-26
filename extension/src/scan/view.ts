// The Scanner view, pure: reading what `scan-cli` prints, which actions the
// flow offers in which state, the tiles' titles, the detail texts, the poll
// rhythm. No `@raycast/api` (the component is `scanner.tsx`, the CLI calls are
// `view-run.ts`), so all of it is unit-tested.

import type { DocThumb } from "./doc-thumbs";
import type {
  DocumentsResult,
  FiledDoc,
  ReviewDoc,
  WaitingDoc,
} from "./documents";
import type { ScanStatus } from "./filing";

export type { ScanStatus } from "./filing";
export type { DocThumb } from "./doc-thumbs";
export type {
  DocumentsResult,
  FiledDoc,
  ReviewDoc,
  WaitingDoc,
} from "./documents";

type Part = NonNullable<ScanStatus["pending"]>["parts"][number];

const pagesText = (n: number): string => `${n} page${n === 1 ? "" : "s"}`;

// ─── reading the CLI's lines ────────────────────────────────────────────────

function lastJson(stdout: string): unknown {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

// `scan-cli --status`; null when the line is not the documented shape.
export function parseStatus(stdout: string): ScanStatus | null {
  const value = lastJson(stdout) as {
    pending?: unknown;
    progress?: unknown;
  } | null;
  if (!value || !("pending" in value)) return null;
  const progress = value.progress as ScanStatus["progress"] | undefined;
  const validProgress =
    progress &&
    typeof progress.mode === "string" &&
    Number.isInteger(progress.page)
      ? { progress }
      : {};
  if (value.pending === null) return { pending: null, ...validProgress };
  const pending = value.pending as {
    parts?: unknown;
    scanning?: unknown;
  };
  if (!Array.isArray(pending?.parts)) return null;
  const parts: Part[] = [];
  for (const raw of pending.parts as Record<string, unknown>[]) {
    if (
      typeof raw?.mode !== "string" ||
      typeof raw.fileName !== "string" ||
      !Number.isInteger(raw.pages) ||
      !isStringArray(raw.pagePaths) ||
      typeof raw.pdfPath !== "string"
    ) {
      return null;
    }
    parts.push({
      mode: raw.mode,
      fileName: raw.fileName,
      pages: raw.pages as number,
      at: typeof raw.at === "number" ? raw.at : 0,
      pagePaths: raw.pagePaths,
      thumbPaths: Array.isArray(raw.thumbPaths)
        ? (raw.thumbPaths as unknown[]).map((p) =>
            typeof p === "string" ? p : null,
          )
        : raw.pagePaths.map(() => null),
      pdfPath: raw.pdfPath,
    });
  }
  return {
    pending: { parts, scanning: pending.scanning === true },
    ...validProgress,
  };
}

export const DOCUMENTS_UNREADABLE = "The document list could not be read";

// `scan-cli --documents`; a plain failure for anything else.
export function parseDocuments(stdout: string): DocumentsResult {
  const v = lastJson(stdout) as Record<string, unknown> | null;
  if (v?.ok === false && typeof v.message === "string") {
    return { ok: false, message: v.message };
  }
  const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  if (v?.ok !== true) return { ok: false, message: DOCUMENTS_UNREADABLE };
  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  const num = (x: unknown): number => (typeof x === "number" ? x : 0);
  return {
    ok: true,
    waiting: arr(v.waiting).map((x) => {
      const d = x as Record<string, unknown>;
      return {
        name: str(d.name),
        path: str(d.path),
        size: num(d.size),
        mtime: num(d.mtime),
      };
    }),
    review: arr(v.review).map((x) => {
      const d = x as Record<string, unknown>;
      return {
        name: str(d.name),
        path: str(d.path),
        mtime: num(d.mtime),
        why: typeof d.why === "string" ? d.why : null,
      };
    }),
    done: [],
    filed: arr(v.filed).map((x) => {
      const d = x as Record<string, unknown>;
      return {
        title: str(d.title),
        kind: str(d.kind),
        issuer: str(d.issuer),
        date: str(d.date),
        tags: isStringArray(d.tags) ? d.tags : [],
        summary: str(d.summary),
        path: str(d.path),
        notePath: str(d.notePath),
        exists: d.exists === true,
      };
    }),
    filedAsOf: typeof v.filedAsOf === "number" ? v.filedAsOf : null,
    filedNote: typeof v.filedNote === "string" ? v.filedNote : undefined,
  };
}

// `scan-cli --doc-thumbs`: document path -> thumbnail file path.
export function parseDocThumbs(stdout: string): DocThumb[] {
  const v = lastJson(stdout) as { thumbs?: unknown } | null;
  if (!Array.isArray(v?.thumbs)) return [];
  return (v.thumbs as Record<string, unknown>[]).flatMap((t) =>
    typeof t?.path === "string" && typeof t.thumbPath === "string"
      ? [{ path: t.path, thumbPath: t.thumbPath }]
      : [],
  );
}

export const thumbMap = (
  thumbs: DocThumb[] | undefined,
): Record<string, string> =>
  Object.fromEntries((thumbs ?? []).map((t) => [t.path, t.thumbPath]));

// ─── the flow ───────────────────────────────────────────────────────────────

export const isScanning = (status: ScanStatus | undefined): boolean =>
  status?.pending?.scanning === true || status?.progress !== undefined;

export const pendingPageCount = (status: ScanStatus | undefined): number =>
  (status?.pending?.parts ?? []).reduce((sum, p) => sum + p.pages, 0);

export type FlowActionId =
  | "scan-document"
  | "scan-fronts"
  | "scan-flatbed"
  | "scan-backs"
  | "scan-more"
  | "submit"
  | "submit-fronts"
  | "discard"
  | "open-log"
  | "refresh";

export interface FlowAction {
  id: FlowActionId;
  // `new-scan`: starting it files the pending scan first
  group: "main" | "new-scan" | "footer";
}

const main = (...ids: FlowActionId[]): FlowAction[] =>
  ids.map((id) => ({ id, group: "main" }));

// The actions the flow offers, in order, for the state of the scanner.
export function scannerActions(status: ScanStatus | undefined): FlowAction[] {
  const footer: FlowAction[] = [
    { id: "open-log", group: "footer" },
    { id: "refresh", group: "footer" },
  ];
  if (isScanning(status)) return footer;
  const parts = status?.pending?.parts ?? [];
  if (parts.length === 0) {
    return [...main("scan-document", "scan-fronts", "scan-flatbed"), ...footer];
  }
  if (parts.length === 2) {
    return [...main("submit", "scan-more", "discard"), ...footer];
  }
  if (parts[0].mode === "fronts") {
    return [
      ...main("scan-backs", "scan-more", "submit-fronts", "discard"),
      ...footer,
    ];
  }
  return [
    ...main("submit", "scan-more", "discard"),
    ...(["scan-document", "scan-fronts", "scan-flatbed"] as const).map(
      (id): FlowAction => ({ id, group: "new-scan" }),
    ),
    ...footer,
  ];
}

export const SCAN_MODE_OF: Partial<Record<FlowActionId, string>> = {
  "scan-document": "feeder",
  "scan-fronts": "fronts",
  "scan-flatbed": "flatbed",
  "scan-backs": "backs",
  "scan-more": "more",
};

export const POLL_SCANNING_MS = 2_000;
export const POLL_IDLE_MS = 10_000;
export const POLL_AFTER_ACTION_MS = 30_000;

// Every 2 s while a scan runs (or was just started: the process needs a moment
// to take the scan lock), every 10 s otherwise.
export function pollInterval(opts: {
  status: ScanStatus | undefined;
  fastUntil: number;
  now: number;
}): number {
  return isScanning(opts.status) || opts.now < opts.fastUntil
    ? POLL_SCANNING_MS
    : POLL_IDLE_MS;
}

export function scanningTitle(status: ScanStatus | undefined): string | null {
  if (!isScanning(status)) return null;
  const page = status?.progress?.page ?? 0;
  return page > 0 ? `Scanning… page ${page}` : "Scanning…";
}

// The hub tile's line.
export function tileStatus(status: ScanStatus): string {
  if (isScanning(status)) return "Scanning…";
  const pages = pendingPageCount(status);
  return pages > 0 ? `${pagesText(pages)} pending` : "Ready";
}

// `Scan · 17 pages`, `Fronts · 17 pages`, `Backs · 16 pages (fronts had 17)`.
export function partTitle(parts: Part[], index: number): string {
  const part = parts[index];
  const label =
    part.mode === "fronts"
      ? "Fronts"
      : part.mode === "backs"
        ? "Backs"
        : "Scan";
  const fronts = parts[0];
  const note =
    part.mode === "backs" &&
    fronts.mode === "fronts" &&
    fronts.pages !== part.pages
      ? ` (fronts had ${fronts.pages})`
      : "";
  return `${label} · ${pagesText(part.pages)}${note}`;
}

export const pageTitle = (index: number): string => `Page ${index + 1}`;

// ─── the documents ──────────────────────────────────────────────────────────

export interface DocTile {
  title: string;
  subtitle: string;
  keywords: string[];
  // false: nothing to open (the file is gone)
  openable: boolean;
}

const words = (...parts: string[]): string[] => parts.filter((p) => p !== "");

export function filedTile(doc: FiledDoc): DocTile {
  return {
    title: doc.issuer || doc.title,
    subtitle: doc.exists
      ? words(doc.kind, doc.date).join(" · ") || "filed"
      : "file not found",
    keywords: words(doc.title, doc.issuer, doc.kind, ...doc.tags),
    openable: doc.exists,
  };
}

// `proposal: kind letter` in the consumer's why text.
export function proposalKind(why: string | null): string | null {
  return /^\s*proposal:\s*kind\s+(\S+)/im.exec(why ?? "")?.[1] ?? null;
}

export function reviewTile(doc: ReviewDoc): DocTile {
  return {
    title: doc.name,
    subtitle: proposalKind(doc.why) ?? "needs review",
    keywords: words(doc.name),
    openable: true,
  };
}

export function waitingTile(doc: WaitingDoc): DocTile {
  return {
    title: doc.name,
    subtitle: "waiting",
    keywords: words(doc.name),
    openable: true,
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");
export const clockTime = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dateTime = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockTime(ms)}`;
};

// `Recently filed · as of 14:20`: the index is a local clone and may lag.
export const filedSectionTitle = (asOf: number | null): string =>
  asOf === null
    ? "Recently filed"
    : `Recently filed · as of ${clockTime(asOf)}`;

// What the document thumbnails depend on: refetched only when this changes.
export function documentSignature(docs: DocumentsResult | undefined): string {
  if (!docs?.ok) return "";
  return [
    ...docs.review.map((d) => `r:${d.path}:${d.mtime}`),
    ...docs.waiting.map((d) => `w:${d.path}:${d.mtime}`),
    ...docs.filed.filter((d) => d.exists).map((d) => `f:${d.path}`),
  ].join("|");
}

const cell = (text: string): string => text.replace(/\|/g, "\\|");

export function filedDetailMarkdown(doc: FiledDoc): string {
  const rows: [string, string][] = [
    ["Kind", doc.kind],
    ["Issuer", doc.issuer],
    ["Date", doc.date],
    ["Tags", doc.tags.join(", ")],
  ];
  const table = rows
    .filter(([, value]) => value !== "")
    .map(([label, value]) => `| ${label} | ${cell(value)} |`);
  return [
    `# ${doc.title}`,
    ...(table.length > 0 ? ["", "| | |", "|-|-|", ...table] : []),
    ...(doc.summary ? ["", doc.summary] : []),
    "",
    doc.path
      ? `\`${doc.path}\`${doc.exists ? "" : " (file not found)"}`
      : "_No file path in the index note._",
  ].join("\n");
}

export function reviewDetailMarkdown(doc: ReviewDoc): string {
  const kind = proposalKind(doc.why);
  const why = (doc.why ?? "The consumer gave no reason.")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    `# ${doc.name}`,
    "",
    why,
    "",
    kind
      ? `The consumer proposes **${kind}**; "File as One Document" accepts the file as a single document.`
      : `"File as One Document" accepts the file as a single document.`,
  ].join("\n");
}

export const formatBytes = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} kB`;

export function waitingDetailMarkdown(doc: WaitingDoc): string {
  return [
    `# ${doc.name}`,
    "",
    "| | |",
    "|-|-|",
    `| Size | ${formatBytes(doc.size)} |`,
    `| Arrived | ${dateTime(doc.mtime)} |`,
    "",
    "Waiting for the inbox consumer.",
    "",
    `\`${doc.path}\``,
  ].join("\n");
}
