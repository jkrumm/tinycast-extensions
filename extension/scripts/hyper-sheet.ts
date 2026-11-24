// `make hyper-sheet` — the printable Hyper key sheet, from the live settings.
// Run from `extension/`:
//
//   bun scripts/hyper-sheet.ts <out-dir>
//
// Writes <out-dir>/hyper-sheet.html. With Google Chrome installed it also writes
// hyper-sheet.pdf (A4 landscape, one page) and hyper-sheet.png (page 1 preview).
// Nothing is opened. The pure model and renderer live in src/shortcuts/sheet*.ts.

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  AppInfo,
  Binding,
  parseCommands,
  parseTinycastSettings,
  parseWalkingPadHotkeys,
} from "../src/shortcuts/parse";
import { RowIcon, ShortcutsData } from "../src/shortcuts/format";
import { buildHyperSheet, WALKINGPAD_BUNDLE_ID } from "../src/shortcuts/sheet";
import { renderHyperSheet } from "../src/shortcuts/sheet-html";
import {
  appIndex,
  exportDomain,
  keyboardLayout,
} from "../src/shortcuts/system";

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TINYCAST_DOMAIN = "com.abueammar.tinycast";
const WALKINGPAD_DOMAIN = "com.jkrumm.walkingpad.client";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PLUTIL = "/usr/bin/plutil";
const SIPS = "/usr/bin/sips";
const ICON_PX = 96;
// A4 landscape at 96 dpi, as the screenshot viewport; the scale factor makes it 150 dpi.
const PREVIEW_WINDOW = "1123,794";
const PREVIEW_SCALE = "1.5625";
const CHROME_TIMEOUT_MS = 60_000;

function bundleIconFile(appPath: string): string | null {
  const plist = join(appPath, "Contents", "Info.plist");
  let name: string;
  try {
    name = execFileSync(
      PLUTIL,
      ["-extract", "CFBundleIconFile", "raw", plist],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return null;
  }
  if (!name) return null;
  const file = name.includes(".") ? name : `${name}.icns`;
  const source = join(appPath, "Contents", "Resources", file);
  return existsSync(source) ? source : null;
}

function pngDataUri(source: string, scratch: string): string | null {
  const out = join(scratch, `icon-${Math.random().toString(36).slice(2)}.png`);
  try {
    execFileSync(
      SIPS,
      [
        "-s",
        "format",
        "png",
        "--resampleWidth",
        String(ICON_PX),
        source,
        "--out",
        out,
      ],
      {
        stdio: "ignore",
      },
    );
  } catch {
    return null;
  }
  return `data:image/png;base64,${readFileSync(out).toString("base64")}`;
}

// Icons are read once per file. Apps without a CFBundleIconFile (asset catalog
// only) and missing files get the lettered tile.
function makeIconOf(scratch: string): (icon: RowIcon) => string | null {
  const cache = new Map<string, string | null>();
  return (icon) => {
    if (icon.kind === "fallback") return null;
    const source =
      icon.kind === "app"
        ? bundleIconFile(icon.path)
        : join(EXT_DIR, "assets", icon.file);
    if (!source) return null;
    if (!cache.has(source)) cache.set(source, pngDataUri(source, scratch));
    return cache.get(source) ?? null;
  };
}

async function readWalkingPad(): Promise<Record<string, Binding> | null> {
  try {
    return parseWalkingPadHotkeys(await exportDomain(WALKINGPAD_DOMAIN));
  } catch {
    return null;
  }
}

// Headless Chrome with a throwaway profile, so a running Chrome can't take the
// command over. Returns the files it wrote.
function renderWithChrome(htmlPath: string, outDir: string): string[] {
  if (!existsSync(CHROME)) return [];
  const profile = mkdtempSync(join(tmpdir(), "hyper-sheet-chrome-"));
  const url = pathToFileURL(htmlPath).href;
  const base = [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
  ];
  const pdf = join(outDir, "hyper-sheet.pdf");
  const png = join(outDir, "hyper-sheet.png");
  const run = (args: string[]) =>
    execFileSync(CHROME, [...base, ...args, url], {
      stdio: "ignore",
      timeout: CHROME_TIMEOUT_MS,
    });
  try {
    run(["--no-pdf-header-footer", `--print-to-pdf=${pdf}`]);
    run([
      `--screenshot=${png}`,
      `--window-size=${PREVIEW_WINDOW}`,
      `--force-device-scale-factor=${PREVIEW_SCALE}`,
    ]);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  return [pdf, png];
}

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (!outDir) throw new Error("usage: bun scripts/hyper-sheet.ts <out-dir>");

  const settings = parseTinycastSettings(await exportDomain(TINYCAST_DOMAIN));
  const walkingPad = await readWalkingPad();
  const layout = await keyboardLayout();
  const index = await appIndex();
  const bundleIds = [
    ...Object.keys(settings.hotkeys)
      .filter((action) => action.startsWith("app."))
      .map((action) => action.slice(4)),
    WALKINGPAD_BUNDLE_ID,
  ];
  const apps: Record<string, AppInfo> = Object.fromEntries(
    bundleIds.flatMap((id) => (index[id] ? [[id, index[id]]] : [])),
  );
  const commands = parseCommands(
    readFileSync(join(EXT_DIR, "package.json"), "utf8"),
  );
  const data: ShortcutsData = { settings, apps, commands, layout };

  const scratch = mkdtempSync(join(tmpdir(), "hyper-sheet-icons-"));
  try {
    const sheet = buildHyperSheet(
      {
        data,
        walkingPad,
        generatedOn: new Date().toLocaleDateString("en-CA"),
      },
      makeIconOf(scratch),
    );
    mkdirSync(outDir, { recursive: true });
    const htmlPath = join(outDir, "hyper-sheet.html");
    writeFileSync(htmlPath, renderHyperSheet(sheet));
    console.log(htmlPath);
    for (const file of renderWithChrome(htmlPath, outDir)) console.log(file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
