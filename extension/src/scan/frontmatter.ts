// A small YAML-frontmatter reader for the document index notes (scalars,
// quoted strings, inline `[a, b]` lists and block `- a` lists; nothing else,
// no dependency). Pure and defensive: a note it cannot read is an empty one.

export type FrontmatterValue = string | string[];

export interface Frontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
}

function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\(["\\nt])/g, (_, c: string) =>
        c === "n" ? "\n" : c === "t" ? "\t" : c,
      );
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

// `[a, "b, c", 'd']`: commas inside quotes do not split.
function inlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      current += char;
      quote = char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map(unquote).filter((item) => item !== "");
}

export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: text.trim() };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return { data: {}, body: text.trim() };

  const data: Record<string, FrontmatterValue> = {};
  let listKey: string | null = null;
  const inline = new Set<string>();
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const list = data[listKey];
      if (Array.isArray(list)) list.push(unquote(item[1]));
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) {
      listKey = null;
      continue;
    }
    const [, key, value] = pair;
    if (value.trim() === "") {
      data[key] = [];
      listKey = key;
    } else if (value.trim().startsWith("[") && value.trim().endsWith("]")) {
      data[key] = inlineList(value);
      inline.add(key);
      listKey = null;
    } else {
      data[key] = unquote(value);
      listKey = null;
    }
  }
  // `key:` with nothing under it is an empty scalar, not an empty list.
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length === 0 && !inline.has(key)) {
      data[key] = "";
    }
  }
  return {
    data,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

export const scalar = (value: FrontmatterValue | undefined): string =>
  typeof value === "string" ? value : "";

export const list = (value: FrontmatterValue | undefined): string[] =>
  Array.isArray(value) ? value : value ? [value] : [];
