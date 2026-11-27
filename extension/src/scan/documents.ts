// Read-only views of the scan inbox for the Scanner view: what is waiting in
// the inbox, what the consumer held back for review (with its reason), and the
// classified documents it filed (from the index notes in the brain vault, which
// is a local clone and may lag). Plus Release, the consumer's documented way to
// accept a held file as one document. Pure logic behind an injected fs
// (`DocsFs`), so it is tested with fakes and a temp dir.

import { basename, extname, join } from "path";
import { frontmatterOf, noteToFiled } from "./filed-notes";

export interface FsEntry {
  name: string;
  isFile: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface DocsFs {
  // The entries of a directory, or null when it is not there.
  list(dir: string): FsEntry[] | null;
  readText(path: string): string | null;
  exists(path: string): boolean;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export interface WaitingDoc {
  name: string;
  path: string;
  size: number;
  mtime: number;
}
// The consumer's split proposal, from the `proposal: <n> documents, pages …`
// line of its reason.
export interface ProposedSplit {
  documents: number;
  ranges: string[]; // "1-8", "9": the pages of each proposed document
  starts: number[]; // the first page of every document after the first
}
export interface ReviewDoc {
  name: string;
  path: string;
  mtime: number;
  why: string | null;
  proposedSplit?: ProposedSplit;
}
export interface DoneDoc {
  name: string;
  path: string;
  mtime: number;
}
export interface FiledDoc {
  title: string; // the note's file stem
  kind: string;
  issuer: string;
  date: string;
  tags: string[];
  summary: string;
  path: string; // absolute: the Dokumente dir + the note's share_path
  notePath: string;
  exists: boolean; // the file at `path`
}

export type DocumentsResult =
  | {
      ok: true;
      waiting: WaitingDoc[];
      review: ReviewDoc[];
      done: DoneDoc[];
      filed: FiledDoc[];
      // mtime of the newest index note read: the local clone can lag
      filedAsOf: number | null;
      filedNote?: string;
    }
  | { ok: false; message: string };

export const DOCUMENT_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".heic"];
export const FILED_LIMIT = 20;
export const DONE_LIMIT = 10;
export const NO_INDEX = "Document index not found";

export const isDocumentName = (name: string): boolean =>
  !name.startsWith(".") &&
  DOCUMENT_EXTENSIONS.includes(extname(name).toLowerCase());

const stemOf = (name: string): string =>
  name.slice(0, name.length - extname(name).length);
const newestFirst = <T extends { mtime: number }>(a: T, b: T): number =>
  b.mtime - a.mtime;

const SPLIT_PROPOSAL =
  /^\s*proposal:\s*(\d+)\s+documents?,\s*pages?\s+(.+?)\s*$/im;
const PAGE_RANGE = /^(\d+)(?:-(\d+))?$/;

// Null unless the reason carries a well-formed list: one range per document,
// contiguous and ascending from page 1, at least two documents.
export function parseProposedSplit(why: string | null): ProposedSplit | null {
  const match = SPLIT_PROPOSAL.exec(why ?? "");
  if (!match) return null;
  const documents = Number(match[1]);
  const ranges = match[2].split(",").map((range) => range.trim());
  if (documents < 2 || ranges.length !== documents) return null;
  const starts: number[] = [];
  let next = 1;
  for (let index = 0; index < ranges.length; index++) {
    const parts = PAGE_RANGE.exec(ranges[index]);
    if (!parts) return null;
    const first = Number(parts[1]);
    const last = parts[2] === undefined ? first : Number(parts[2]);
    if (first !== next || last < first) return null;
    if (index > 0) starts.push(first);
    next = last + 1;
  }
  return { documents, ranges, starts };
}

// `<stem>-vorne.pdf` / `-hinten.pdf` (or -front / -back): the two sides the
// consumer collated into `<stem>.pdf`, which is listed instead.
const COLLATED_SIDE = /^(.+)-(vorne|hinten|front|back)$/i;
const isCollatedSide = (name: string, held: Set<string>): boolean => {
  const side = COLLATED_SIDE.exec(stemOf(name));
  return side !== null && held.has(`${side[1]}.pdf`);
};

export function listDocuments(
  fs: DocsFs,
  opts: { inbox: string; brainDir?: string; dokumenteDir?: string },
): DocumentsResult {
  const top = fs.list(opts.inbox);
  if (!top) {
    return {
      ok: false,
      message: "Scan inbox not found (is the share mounted?)",
    };
  }

  const waiting: WaitingDoc[] = top
    .filter((e) => e.isFile && isDocumentName(e.name))
    .map((e) => ({
      name: e.name,
      path: join(opts.inbox, e.name),
      size: e.size,
      mtime: e.mtimeMs,
    }))
    .sort(newestFirst);

  const reviewDir = join(opts.inbox, "review");
  const reviewEntries = fs.list(reviewDir) ?? [];
  const heldNames = new Set(
    reviewEntries.filter((e) => e.isFile).map((e) => e.name),
  );
  const review: ReviewDoc[] = reviewEntries
    .filter(
      (e) =>
        e.isFile &&
        isDocumentName(e.name) &&
        !isCollatedSide(e.name, heldNames),
    )
    .map((e) => {
      const why =
        fs.readText(join(reviewDir, `${stemOf(e.name)}.why.txt`))?.trim() ||
        null;
      const split = parseProposedSplit(why);
      return {
        name: e.name,
        path: join(reviewDir, e.name),
        mtime: e.mtimeMs,
        why,
        ...(split ? { proposedSplit: split } : {}),
      };
    })
    .sort(newestFirst);

  const doneDir = join(opts.inbox, "done");
  const done: DoneDoc[] = (fs.list(doneDir) ?? [])
    .filter((e) => e.isFile && !e.name.startsWith("."))
    .map((e) => ({
      name: e.name,
      path: join(doneDir, e.name),
      mtime: e.mtimeMs,
    }))
    .sort(newestFirst)
    .slice(0, DONE_LIMIT);

  return { ok: true, waiting, review, done, ...listFiled(fs, opts) };
}

// The 20 newest index notes (frontmatter `date` desc, then mtime).
function listFiled(
  fs: DocsFs,
  opts: { brainDir?: string; dokumenteDir?: string },
): { filed: FiledDoc[]; filedAsOf: number | null; filedNote?: string } {
  const root = opts.brainDir ? join(opts.brainDir, "Areas", "Documents") : null;
  const years = root ? fs.list(root) : null;
  if (!root || !years)
    return { filed: [], filedAsOf: null, filedNote: NO_INDEX };

  const notes: { doc: FiledDoc; date: string; mtime: number }[] = [];
  for (const year of years.filter((e) => e.isDir && !e.name.startsWith("."))) {
    const dir = join(root, year.name);
    for (const entry of fs.list(dir) ?? []) {
      if (
        !entry.isFile ||
        entry.name.startsWith(".") ||
        extname(entry.name) !== ".md"
      ) {
        continue;
      }
      const notePath = join(dir, entry.name);
      const text = fs.readText(notePath);
      if (text === null) continue;
      const note = frontmatterOf(text);
      notes.push({
        doc: noteToFiled(note, {
          title: basename(entry.name, ".md"),
          notePath,
          dokumenteDir: opts.dokumenteDir,
          exists: (path) => fs.exists(path),
        }),
        date: note.date,
        mtime: entry.mtimeMs,
      });
    }
  }
  notes.sort(
    (a, b) =>
      (a.date === b.date
        ? 0
        : !a.date
          ? 1
          : !b.date
            ? -1
            : a.date < b.date
              ? 1
              : -1) || b.mtime - a.mtime,
  );
  return {
    filed: notes.slice(0, FILED_LIMIT).map((n) => n.doc),
    filedAsOf: notes.reduce<number | null>(
      (max, n) => (max === null || n.mtime > max ? n.mtime : max),
      null,
    ),
  };
}

export type ReleaseResult = { ok: boolean; message: string };

export const SPLIT_LIMIT = 50;
const SPLIT_HELP =
  "Split needs up to 50 page numbers from 2, strictly ascending (e.g. split-9-10-12-14)";

// `split-<n>-<n>…`: the first page of each document after the first, so the
// consumer's decision reads the same as its own naming. Null when malformed.
const splitPages = (as: string): number[] | null => {
  const match = /^split-(\d+(?:-\d+)*)$/.exec(as);
  if (!match) return null;
  const pages = match[1].split("-").map(Number);
  const ascending = pages.every(
    (page, i) => page >= 2 && (i === 0 || page > pages[i - 1]),
  );
  return ascending && pages.length <= SPLIT_LIMIT ? pages : null;
};

// The target's name part and how many documents it makes, or null.
const releaseForm = (
  as: string,
): { part: string; documents: number } | null => {
  if (as === "single") return { part: "single", documents: 1 };
  const pages = splitPages(as);
  return pages
    ? { part: `split-${pages.join("-")}`, documents: pages.length + 1 }
    : null;
};

// Moves `<inbox>/review/<name>` to `<inbox>/<stem>.single.pdf` (or
// `<stem>.split-<n>-<n>….pdf` for a proposed split) — the consumer's way to
// accept a held file — and drops its `.why.txt`. Only a plain PDF file name
// inside review/ is accepted. An earlier `.single` / `.split-…` part of the
// stem is replaced, not stacked.
export function releaseReview(
  fs: DocsFs,
  opts: { inbox: string; name: string; as: string },
): ReleaseResult {
  const { name } = opts;
  const form = releaseForm(opts.as);
  if (!form) {
    return {
      ok: false,
      message: opts.as.startsWith("split-")
        ? SPLIT_HELP
        : "Only --as single or --as split-<n>-<n>… is supported",
    };
  }
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.startsWith(".") ||
    name.includes("\0")
  ) {
    return { ok: false, message: "Not a file name in review/" };
  }
  if (extname(name).toLowerCase() !== ".pdf") {
    return {
      ok: false,
      message: "Only PDF files can be filed as one document",
    };
  }
  const reviewDir = join(opts.inbox, "review");
  const source = join(reviewDir, name);
  if (!fs.list(reviewDir)?.some((e) => e.isFile && e.name === name)) {
    return { ok: false, message: `${name} is not in review/` };
  }
  const stem = stemOf(name);
  const base = stem.replace(/\.(single|split-\d+(?:-\d+)*)$/, "");
  const targetName = `${base}.${form.part}.pdf`;
  const target = join(opts.inbox, targetName);
  if (fs.exists(target)) {
    return { ok: false, message: `${targetName} already exists in the inbox` };
  }
  fs.rename(source, target);
  fs.remove(join(reviewDir, `${stem}.why.txt`));
  return {
    ok: true,
    message:
      form.documents === 1
        ? `Filed as one document: ${targetName}`
        : `Filed as ${form.documents} documents: ${targetName}`,
  };
}
