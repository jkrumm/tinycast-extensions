// Pure eSCL (AirScan) pieces: the scan-settings document, the status reader,
// job URLs, the `dns-sd` output parsers and the output file names. No
// `@raycast/api`, no fs, no network — the runner and the transport live
// beside it. Protocol facts are in AGENTS.md § Data sources (Scanner).

// `more` is a feeder scan appended to the last delivered one (continue.ts).
export const SCAN_MODES = [
  "feeder",
  "fronts",
  "backs",
  "flatbed",
  "more",
] as const;
export type ScanMode = (typeof SCAN_MODES)[number];
export type ScanSource = "Feeder" | "Platen";
export type ScanColor = "RGB24" | "Grayscale8";

export const SCAN_DPI = 300;

export const isFeederMode = (mode: ScanMode): boolean => mode !== "flatbed";

export const sourceFor = (mode: ScanMode): ScanSource =>
  isFeederMode(mode) ? "Feeder" : "Platen";

// A4 in 1/300 inch.
const A4_WIDTH = 2480;
const A4_HEIGHT = 3507;

export function scanSettingsXml(opts: {
  source: ScanSource;
  dpi: number;
  color: ScanColor;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">',
    "<pwg:Version>2.63</pwg:Version>",
    "<scan:Intent>Document</scan:Intent>",
    `<pwg:ScanRegions><pwg:ScanRegion><pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits><pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset><pwg:Width>${A4_WIDTH}</pwg:Width><pwg:Height>${A4_HEIGHT}</pwg:Height></pwg:ScanRegion></pwg:ScanRegions>`,
    `<pwg:InputSource>${opts.source}</pwg:InputSource>`,
    `<scan:ColorMode>${opts.color}</scan:ColorMode>`,
    `<scan:XResolution>${opts.dpi}</scan:XResolution>`,
    `<scan:YResolution>${opts.dpi}</scan:YResolution>`,
    "<pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>",
    "<scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>",
    "</scan:ScanSettings>",
  ].join("\n");
}

export interface ScannerJob {
  uri: string; // as the scanner gave it (a path)
  state: string | null;
  imagesCompleted: number | null;
  reason: string | null;
}

export interface ScannerStatus {
  state: string | null;
  adfState: string | null;
  // One entry per past job. A running job is NOT listed while it runs; a
  // finished one stays listed (also after DELETE).
  jobs: ScannerJob[];
}

// The first `<pwg:State>` only: a status document also lists `<pwg:JobState>`
// per job, which must never be mistaken for the scanner's own state.
export function parseScannerStatus(xml: string): ScannerStatus {
  const text = typeof xml === "string" ? xml : "";
  const pick = (re: RegExp, from = text): string | null =>
    re.exec(from)?.[1]?.trim() || null;
  const jobs: ScannerJob[] = [];
  for (const block of text.matchAll(
    /<scan:JobInfo>([\s\S]*?)<\/scan:JobInfo>/g,
  )) {
    const body = block[1];
    const uri = pick(/<pwg:JobUri>\s*([^<]*?)\s*<\/pwg:JobUri>/, body);
    if (!uri) continue;
    const completed = pick(
      /<pwg:ImagesCompleted>\s*([^<]*?)\s*<\/pwg:ImagesCompleted>/,
      body,
    );
    jobs.push({
      uri,
      state: pick(/<pwg:JobState>\s*([^<]*?)\s*<\/pwg:JobState>/, body),
      imagesCompleted:
        completed !== null && /^\d+$/.test(completed)
          ? Number(completed)
          : null,
      reason: pick(
        /<pwg:JobStateReason>\s*([^<]*?)\s*<\/pwg:JobStateReason>/,
        body,
      ),
    });
  }
  return {
    state: pick(/<pwg:State>\s*([^<]*?)\s*<\/pwg:State>/),
    adfState: pick(/<scan:AdfState>\s*([^<]*?)\s*<\/scan:AdfState>/),
    jobs,
  };
}

// The job's id: the last path segment (a uuid), whether the URL is absolute
// or a path, with or without a trailing slash.
const lastSegment = (url: string): string =>
  url.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() ?? "";

export function findJob(
  status: ScannerStatus,
  jobUrl: string,
): ScannerJob | null {
  const id = lastSegment(jobUrl);
  if (!id) return null;
  return status.jobs.find((job) => lastSegment(job.uri) === id) ?? null;
}

// `Location` of a created job: absolute, or a path on the scanner's host.
export function jobUrl(base: string, locationHeader: string): string {
  const location = locationHeader.trim();
  const root = base.replace(/\/+$/, "");
  const url = /^https?:\/\//i.test(location)
    ? location
    : `${root}${location.startsWith("/") ? "" : "/"}${location}`;
  return url.replace(/\/+$/, "");
}

// `dns-sd -B _uscan._tcp local.`: the instance name of the first `Add` line —
// everything after the service-type column, spaces included.
export function parseBrowse(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match =
      /^\S+\s+Add\s+\d+\s+\d+\s+\S+\s+_uscan\._tcp\.?\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

// `dns-sd -L …`: `http://<host>[:port]` from the `can be reached at` line.
export function parseLookup(stdout: string): string | null {
  const match = /can be reached at\s+(\S+?):(\d+)(?:\s|$)/.exec(stdout);
  if (!match) return null;
  const host = match[1].replace(/\.$/, "");
  const port = Number(match[2]);
  return port === 80 ? `http://${host}` : `http://${host}:${port}`;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

// `scan-YYYY-MM-DD-HHmmss`, local time.
export function scanStem(now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `scan-${date}-${time}`;
}

// feeder/more/flatbed → `<stem>.pdf`; fronts → `<stem>-vorne.pdf`; backs →
// `<stem of the last fronts scan>-hinten.pdf`. The consumer that collates
// double-sided stacks keys on the two suffixes only.
export function scanFileName(
  mode: ScanMode,
  now: Date,
  frontsStem?: string,
): string {
  if (mode === "backs") {
    if (!frontsStem) throw new Error("A backs scan needs the fronts stem");
    return `${frontsStem}-hinten.pdf`;
  }
  const stem = scanStem(now);
  return mode === "fronts" ? `${stem}-vorne.pdf` : `${stem}.pdf`;
}

// `scan-2026-11-26-183455-vorne.pdf` → `scan-2026-11-26-183455`.
export const frontsStemOf = (fileName: string): string =>
  fileName.replace(/-vorne\.pdf$/, "").replace(/\.pdf$/, "");

// `name.pdf` → `name-2.pdf`, `name-3.pdf`, …
export const numberedFileName = (fileName: string, n: number): string =>
  n <= 1 ? fileName : fileName.replace(/\.pdf$/, `-${n}.pdf`);
