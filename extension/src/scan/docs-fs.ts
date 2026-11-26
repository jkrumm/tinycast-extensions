// The real filesystem behind `DocsFs` (documents.ts).

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { join } from "path";
import { DocsFs, FsEntry } from "./documents";

export const nodeDocsFs: DocsFs = {
  list(dir): FsEntry[] | null {
    try {
      return readdirSync(dir).flatMap((name) => {
        try {
          const stat = statSync(join(dir, name));
          return [
            {
              name,
              isFile: stat.isFile(),
              isDir: stat.isDirectory(),
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            },
          ];
        } catch {
          return []; // gone since the listing
        }
      });
    } catch {
      return null;
    }
  },
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists: (path) => existsSync(path),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};
