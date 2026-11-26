// An index note of a filed document (written by the inbox consumer into the
// brain vault: `Areas/Documents/<year>/<name>.md`) as the Scanner view needs
// it. Pure.

import { join } from "path";
import { list, parseFrontmatter, scalar } from "./frontmatter";
import type { FiledDoc } from "./documents";

export interface NoteFields {
  kind: string;
  issuer: string;
  date: string;
  tags: string[];
  summary: string;
  sharePath: string;
}

export function frontmatterOf(text: string): NoteFields {
  const { data, body } = parseFrontmatter(text);
  return {
    kind: scalar(data.kind),
    issuer: scalar(data.issuer),
    date: scalar(data.date),
    tags: list(data.tags),
    // the body is a short summary: one line, no heading marks
    summary: body
      .split("\n")
      .filter((line) => !/^#{1,6}\s/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    sharePath: scalar(data.share_path),
  };
}

export function noteToFiled(
  note: NoteFields,
  at: {
    title: string;
    notePath: string;
    dokumenteDir?: string;
    exists(path: string): boolean;
  },
): FiledDoc {
  const path =
    at.dokumenteDir && note.sharePath
      ? join(at.dokumenteDir, note.sharePath)
      : "";
  return {
    title: at.title,
    kind: note.kind,
    issuer: note.issuer,
    date: note.date,
    tags: note.tags,
    summary: note.summary,
    path,
    notePath: at.notePath,
    exists: path !== "" && at.exists(path),
  };
}
