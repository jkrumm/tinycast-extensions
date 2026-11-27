// The real ports behind the print CLI: CUPS tools through execFile with
// LC_ALL=C, ipptool test files in a temp directory, the file stat, the clock.
// Plain node/bun: nothing here may import `@raycast/api`.

import { execFile } from "child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import { CupsPorts } from "./cups";

export function systemCupsPorts(): CupsPorts {
  return {
    user: userInfo().username,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    exec: (file, args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(
          file,
          args,
          {
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, LC_ALL: "C" },
          },
          (error, stdout, stderr) =>
            resolve({
              code: error
                ? typeof error.code === "number"
                  ? error.code
                  : -1
                : 0,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
            }),
        );
      }),
    tempFile: (text) => {
      const dir = mkdtempSync(join(tmpdir(), "print-cli-"));
      const path = join(dir, "request.test");
      writeFileSync(path, text);
      return {
        path,
        remove: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  };
}

export function systemStat(path: string): { isFile: boolean } | null {
  try {
    return { isFile: statSync(path).isFile() };
  } catch {
    return null;
  }
}
