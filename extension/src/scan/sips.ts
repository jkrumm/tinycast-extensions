// macOS' own `sips`, shared by the blank guard (BMP), the page thumbnails and
// the document thumbnails (a PDF's first page). Callback-style `execFile`.

import { execFile } from "child_process";

const SIPS_BIN = "/usr/bin/sips";
export const SIPS_TIMEOUT_MS = 20_000;
export const THUMB_SIZE = "360";

export function sips(
  args: string[],
  timeoutMs = SIPS_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(SIPS_BIN, args, { timeout: timeoutMs }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

// A small JPEG of an image or of a PDF's first page.
export const sipsThumbnail = (
  src: string,
  dest: string,
  timeoutMs = SIPS_TIMEOUT_MS,
): Promise<void> =>
  sips(
    [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "60",
      "-Z",
      THUMB_SIZE,
      src,
      "--out",
      dest,
    ],
    timeoutMs,
  );

// `fn` over every item, at most `limit` at a time, results in item order.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
