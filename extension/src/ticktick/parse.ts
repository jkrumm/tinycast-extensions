import * as chrono from "chrono-node";
import similarity from "similarity";
import { TickTickProject } from "./types";

export interface ParseResult {
  project: TickTickProject | null;
  dueDate: Date | null;
  priority: number; // 0=None, 1=Low, 3=Medium, 5=High
  title: string;
}

const PRIORITY_PATTERN = /\s*!(h(?:igh)?|m(?:ed(?:ium)?)?|l(?:ow)?)\b/gi;

function extractPriority(input: string): { priority: number; text: string } {
  let priority = 0;
  const text = input.replace(PRIORITY_PATTERN, (_, flag) => {
    const f = flag.toLowerCase();
    if (f.startsWith("h")) priority = 5;
    else if (f.startsWith("m")) priority = 3;
    else if (f.startsWith("l")) priority = 1;
    return "";
  });
  return { priority, text: text.replace(/\s+/g, " ").trim() };
}

const PROJECT_HASH_PATTERN = /(?:^|\s)#(\S+)/g;

function extractHashProject(
  input: string,
  projects: TickTickProject[],
): { project: TickTickProject | null; text: string } {
  let project: TickTickProject | null = null;
  const text = input.replace(PROJECT_HASH_PATTERN, (match, word) => {
    if (project) return match; // already found one
    const best = projects.reduce(
      (acc, p) => {
        const score = similarity(word.toLowerCase(), p.name.toLowerCase());
        return score > acc.score ? { score, project: p } : acc;
      },
      { score: 0.3, project: null as TickTickProject | null },
    );
    if (best.project) {
      project = best.project;
      return "";
    }
    return match;
  });
  return { project, text: text.replace(/\s+/g, " ").trim() };
}

function extractStartProject(
  input: string,
  projects: TickTickProject[],
): { project: TickTickProject | null; text: string } {
  const tokens = input.trim().split(/\s+/);
  for (const n of [2, 1]) {
    if (tokens.length < n) continue;
    const candidate = tokens.slice(0, n).join(" ").toLowerCase();
    const best = projects.reduce(
      (acc, p) => {
        // Only try n-token match if the project name itself has at least n words,
        // to prevent "homelab fix" greedily matching the 1-word project "Homelab".
        if (p.name.trim().split(/\s+/).length < n) return acc;
        const score = similarity(candidate, p.name.toLowerCase());
        return score > acc.score ? { score, project: p } : acc;
      },
      { score: 0.4, project: null as TickTickProject | null },
    );
    if (best.project) {
      return {
        project: best.project,
        text: tokens.slice(n).join(" "),
      };
    }
  }
  return { project: null, text: input };
}

// Prepend a custom parser for DD.MM[.YY[YY]] before chrono runs
function parseGermanDateLiteral(text: string, refDate: Date): Date | null {
  const match = text.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  let year = refDate.getFullYear();
  if (match[3]) {
    const raw = parseInt(match[3], 10);
    year = raw < 100 ? 2000 + raw : raw;
  }
  const candidate = new Date(year, month, day, 12, 0, 0);
  // If date is in the past and no year was specified, advance one year
  if (!match[3] && candidate < refDate) {
    candidate.setFullYear(year + 1);
  }
  return candidate;
}

export function parse(input: string, projects: TickTickProject[]): ParseResult {
  // 1. Extract priority shortcuts (!h, !m, !l)
  const { priority, text: afterPriority } = extractPriority(input);

  // 2. Extract #project (preferred) or start-of-input project match
  const hashResult = extractHashProject(afterPriority, projects);
  let project = hashResult.project;
  let titleInput = hashResult.text;

  if (!project) {
    const startResult = extractStartProject(titleInput, projects);
    project = startResult.project;
    titleInput = startResult.text;
  }

  // 3. Extract date
  const ref = { instant: new Date(), timezone: "Europe/Berlin" };
  const opts = { forwardDate: true };

  // Try custom DD.MM[.YY] parser first
  let dueDate: Date | null = null;
  const germanMatch = titleInput.match(
    /\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/,
  );
  if (germanMatch) {
    dueDate = parseGermanDateLiteral(titleInput, ref.instant);
    if (dueDate) {
      titleInput = titleInput
        .replace(germanMatch[0], "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  if (!dueDate) {
    let dateResults = chrono.de.parse(titleInput, ref, opts);
    if (!dateResults.length) dateResults = chrono.parse(titleInput, ref, opts);

    if (dateResults.length > 0) {
      const hit = dateResults[0];
      dueDate = hit.start.date();
      titleInput = (
        titleInput.slice(0, hit.index) +
        titleInput.slice(hit.index + hit.text.length)
      )
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  return { project, dueDate, priority, title: titleInput };
}
