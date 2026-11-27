// A print request as the CLI and the Tinycast surfaces build it, and the `lp`
// argv that submits it. Pure: no fs, no CUPS. Every option that matters is
// passed explicitly; nothing relies on the queue's own defaults.

import { basename, extname } from "path";

export type Check<T> = { ok: true; value: T } | { ok: false; message: string };

export const ok = <T>(value: T): Check<T> => ({ ok: true, value });
export const fail = (message: string): { ok: false; message: string } => ({
  ok: false,
  message,
});

export const SIDES = [
  "two-sided-long-edge",
  "two-sided-short-edge",
  "one-sided",
] as const;
export type Sides = (typeof SIDES)[number];
export const DEFAULT_SIDES: Sides = "two-sided-long-edge";

export const MEDIA = ["A4", "A5", "A6", "Letter", "Legal"] as const;
export type Media = (typeof MEDIA)[number];
export const DEFAULT_MEDIA: Media = "A4";

export const QUALITY = ["draft", "normal", "high"] as const;
export type Quality = (typeof QUALITY)[number];
const QUALITY_VALUE: Record<Quality, number> = { draft: 3, normal: 4, high: 5 };

export const N_UP: readonly number[] = [1, 2, 4, 6, 9, 16];
// Deliberately far below the device's 9999: one typo must not print a stack.
export const MAX_COPIES = 99;
export const FILE_TYPES: readonly string[] = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "txt",
];

export interface PrintRequest {
  file: string;
  printer?: string;
  sides: Sides;
  pages?: string;
  copies: number;
  nUp: number;
  quality?: Quality;
  manualFeed: boolean;
  media: Media;
  hold: boolean;
}

// The raw options as the CLI or a form hands them over; `file` and `printer`
// are checked elsewhere (`checkFile`, the CUPS check).
export interface PrintInput {
  file: string;
  printer?: string;
  sides?: Sides;
  pages?: string;
  copies?: number;
  nUp?: number;
  quality?: string;
  manualFeed?: boolean;
  media?: string;
  hold?: boolean;
}

const PAGES_SYNTAX = /^\d+(-\d*)?(,\d+(-\d*)?)*$/;

// `1-3,5,8-`: digits, ranges, commas. Order is free, the page numbers start
// at 1, and a range must not run backwards.
export function parsePages(text: string): Check<string> {
  const value = text.replace(/\s+/g, "");
  if (!PAGES_SYNTAX.test(value)) {
    return fail(`Invalid page list "${text}" (use e.g. 1-3,5,8-)`);
  }
  for (const part of value.split(",")) {
    const [from, to] = part.split("-");
    if (Number(from) < 1) return fail(`Pages start at 1 ("${part}")`);
    if (to && Number(to) < Number(from)) {
      return fail(`Reversed page range "${part}"`);
    }
  }
  return ok(value);
}

const isOneOf = <T extends string>(
  list: readonly T[],
  value: string,
): value is T => (list as readonly string[]).includes(value);

export function sidesLabel(sides: Sides): string {
  if (sides === "one-sided") return "one-sided";
  return sides === "two-sided-long-edge" ? "two-sided" : "two-sided short edge";
}

export function checkFile(
  path: string,
  stat: (path: string) => { isFile: boolean } | null,
): Check<string> {
  const info = stat(path);
  if (!info) return fail(`No such file: ${path}`);
  if (!info.isFile) return fail(`Not a regular file: ${path}`);
  const type = extname(path).slice(1).toLowerCase();
  if (!isOneOf(FILE_TYPES, type)) {
    const shown = type || "none";
    return fail(
      `Unsupported file type "${shown}" for ${basename(path)} (pdf, png, jpg, tif or txt)`,
    );
  }
  return ok(path);
}

export function buildRequest(input: PrintInput): Check<PrintRequest> {
  const pagesText = input.pages?.trim();
  const pages = pagesText ? parsePages(pagesText) : ok(undefined);
  if (!pages.ok) return pages;

  const copies = input.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
    return fail(`Copies must be a whole number from 1 to ${MAX_COPIES}`);
  }
  const nUp = input.nUp ?? 1;
  if (!N_UP.includes(nUp)) {
    return fail(`--n-up must be one of ${N_UP.join(", ")}`);
  }
  if (input.quality !== undefined && !isOneOf(QUALITY, input.quality)) {
    return fail(`--quality must be one of ${QUALITY.join(", ")}`);
  }
  const media = input.media ?? DEFAULT_MEDIA;
  if (!isOneOf(MEDIA, media)) {
    return fail(`--media must be one of ${MEDIA.join(", ")}`);
  }
  return ok({
    file: input.file,
    printer: input.printer,
    sides: input.sides ?? DEFAULT_SIDES,
    pages: pages.value,
    copies,
    nUp,
    quality: input.quality as Quality | undefined,
    manualFeed: input.manualFeed ?? false,
    media,
    hold: input.hold ?? false,
  });
}

// The `lp` argv for one request. `printer` is the resolved queue; without it
// lp uses its own default, which the CLI never allows.
export function lpArgs(request: PrintRequest): string[] {
  return [
    ...(request.printer ? ["-d", request.printer] : []),
    "-n",
    String(request.copies),
    "-o",
    `sides=${request.sides}`,
    "-o",
    `media=${request.media}`,
    "-o",
    "fit-to-page",
    ...(request.nUp > 1 ? ["-o", `number-up=${request.nUp}`] : []),
    ...(request.quality
      ? ["-o", `print-quality=${QUALITY_VALUE[request.quality]}`]
      : []),
    ...(request.manualFeed ? ["-o", "InputSlot=manual"] : []),
    ...(request.pages ? ["-P", request.pages] : []),
    ...(request.hold ? ["-H", "hold"] : []),
    "-t",
    basename(request.file),
    "--",
    request.file,
  ];
}
