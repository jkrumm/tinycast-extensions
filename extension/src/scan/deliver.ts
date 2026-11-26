// Getting a finished PDF out of the temp dir without ever losing it: copy it
// into the inbox, check the destination's size against the source, and only
// then let the caller remove anything. When the inbox cannot take it (share
// unmounted mid-scan, permission, disk) the PDF is kept in a state-dir folder
// instead. All fs access goes through `DeliverFs`, so the decision is
// unit-tested with a fake.

import { numberedFileName } from "./escl";

export interface DeliverFs {
  // Copy `src` to `dest`, failing with `code: "EEXIST"` when `dest` exists.
  copyExclusive(src: string, dest: string): Promise<void>;
  size(path: string): Promise<number>;
  mkdirp(dir: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export type Delivery =
  | { kind: "sent"; path: string }
  | { kind: "kept"; path: string; error: string };

const join = (dir: string, name: string): string =>
  `${dir.replace(/\/+$/, "")}/${name}`;

// Copies without overwriting (`name.pdf`, `name-2.pdf`, …) and verifies the
// size; a destination that fails verification is removed again so the inbox
// never holds a truncated file.
async function copyVerified(
  fs: DeliverFs,
  src: string,
  dir: string,
  fileName: string,
): Promise<string> {
  for (let n = 1; ; n++) {
    const dest = join(dir, numberedFileName(fileName, n));
    try {
      await fs.copyExclusive(src, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const [want, got] = await Promise.all([fs.size(src), fs.size(dest)]);
    if (want !== got) {
      await fs.remove(dest).catch(() => undefined);
      throw new Error(`Copy incomplete (${got} of ${want} bytes)`);
    }
    return dest;
  }
}

// Keeps the PDF in `dir` (created when missing). Throws when even that fails —
// the caller must then leave the temp dir alone.
export async function keepPdf(
  fs: DeliverFs,
  opts: { src: string; dir: string; fileName: string },
): Promise<string> {
  await fs.mkdirp(opts.dir);
  return copyVerified(fs, opts.src, opts.dir, opts.fileName);
}

export async function deliverPdf(
  fs: DeliverFs,
  opts: { src: string; outDir: string; keepDir: string; fileName: string },
): Promise<Delivery> {
  try {
    const path = await copyVerified(fs, opts.src, opts.outDir, opts.fileName);
    return { kind: "sent", path };
  } catch (error) {
    const path = await keepPdf(fs, {
      src: opts.src,
      dir: opts.keepDir,
      fileName: opts.fileName,
    });
    return {
      kind: "kept",
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
