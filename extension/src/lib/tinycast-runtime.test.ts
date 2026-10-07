// Vitest runs real Node, so a Node API Tinycast's JavaScriptCore shim lacks
// passes every test and only crashes once deployed — `fs/promises.open` did
// exactly that (2026-10-01: every netgear-watchdog tick and every Netgear
// admin action threw "open is not a function"). This pins every non-test
// `fs`/`fs/promises` import to what the shim implements
// (Scripts/raycast-runtime/src/node-shims.js on Tinycast's `main`).

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const TINYCAST_FS = new Set([
  "constants",
  "openSync",
  "closeSync",
  "readSync",
  "writeSync",
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "readdirSync",
  "mkdirSync",
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "renameSync",
  "copyFileSync",
  "realpathSync",
  "accessSync",
  "mkdtempSync",
  "chmodSync",
]);

const TINYCAST_FS_PROMISES = new Set([
  "readFile",
  "writeFile",
  "appendFile",
  "stat",
  "lstat",
  "readdir",
  "opendir",
  "mkdir",
  "rm",
  "rmdir",
  "unlink",
  "rename",
  "copyFile",
  "realpath",
  "access",
  "mkdtemp",
  "chmod",
  "constants",
]);

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "e2e" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const IMPORT = /import\s*\{([^}]*)\}\s*from\s*"(?:node:)?(fs|fs\/promises)"/g;

describe("Tinycast runtime compatibility", () => {
  it("only imports fs functions Tinycast's node shim implements", () => {
    const unsupported: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const [, names, mod] of readFileSync(file, "utf8").matchAll(
        IMPORT,
      )) {
        const allowed = mod === "fs" ? TINYCAST_FS : TINYCAST_FS_PROMISES;
        for (const name of names.split(",").map((n) => n.trim())) {
          const imported = name.split(/\s+as\s+/)[0];
          if (imported && !allowed.has(imported)) {
            unsupported.push(
              `${file.slice(SRC.length + 1)}: ${mod}.${imported}`,
            );
          }
        }
      }
    }
    expect(unsupported).toEqual([]);
  });
});
