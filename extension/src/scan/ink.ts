// The impure half of the blank guard: reduce each scanned page to a small BMP
// with macOS' own `sips` and measure it with `blank.ts`. Callback-style
// `execFile`. A page that cannot be converted or parsed is `null` — the guard
// never blocks a scan on a failed measurement.

import { execFile } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inkShare } from "./blank";

const SIPS_BIN = "/usr/bin/sips";
const SIPS_TIMEOUT_MS = 20_000;
const BMP_MAX_SIZE = "400";

export interface InkPorts {
  convert(src: string, dest: string): Promise<void>;
  readFile(path: string): Uint8Array;
  makeTmpDir(): string;
  remove(path: string): void;
}

const sipsPorts: InkPorts = {
  convert: (src, dest) =>
    new Promise((resolve, reject) => {
      execFile(
        SIPS_BIN,
        ["-s", "format", "bmp", "-Z", BMP_MAX_SIZE, src, "--out", dest],
        { timeout: SIPS_TIMEOUT_MS },
        (error) => (error ? reject(error) : resolve()),
      );
    }),
  readFile: (path) => new Uint8Array(readFileSync(path)),
  makeTmpDir: () => mkdtempSync(join(tmpdir(), "scan-ink-")),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

// The ink share of each page, in order; `null` where it could not be measured.
export async function measureInk(
  pagePaths: string[],
  log: (line: string) => void = () => undefined,
  ports: InkPorts = sipsPorts,
): Promise<(number | null)[]> {
  const dir = ports.makeTmpDir();
  try {
    const shares: (number | null)[] = [];
    for (const [index, src] of pagePaths.entries()) {
      const bmp = join(dir, `ink-${String(index + 1).padStart(3, "0")}.bmp`);
      try {
        await ports.convert(src, bmp);
        shares.push(inkShare(ports.readFile(bmp)));
      } catch (error) {
        log(
          `ink: page ${index + 1} not measured: ${error instanceof Error ? error.message : error}`,
        );
        shares.push(null);
      } finally {
        ports.remove(bmp);
      }
    }
    return shares;
  } finally {
    ports.remove(dir);
  }
}
