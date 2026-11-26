// Blank-batch detection, pure. A stack that went into the feeder upside down
// scans as blank pages whose JPEGs are only slightly smaller than real ones
// (135 vs 178 KB measured), so the size cannot tell: the pixels can. A page is
// reduced to a small BMP (see `ink.ts`) and `inkShare` says how much of its
// inner area is dark. All thresholds live here so they can be calibrated
// against real pages in one place.

// A pixel counts as ink below this luminance (0-255).
export const INK_LUMA = 204;
// A page whose ink share is below this looks blank.
export const BLANK_INK_SHARE = 0.002;
// Outer margins that are ignored: punch holes sit at the sides, the scanner
// edge shadow at top and bottom.
export const MARGIN_X = 0.08;
export const MARGIN_Y = 0.03;

export const isBlankPage = (share: number): boolean => share < BLANK_INK_SHARE;

// A batch is blank only when every page was measured and every one is blank:
// the guard never blocks a scan on a measurement it does not have.
export function isBlankBatch(shares: (number | null)[]): boolean {
  return (
    shares.length > 0 &&
    shares.every((share) => share !== null && isBlankPage(share))
  );
}

// Share of dark pixels in the inner area of an uncompressed 24- or 32-bit BMP,
// 0..1. Handles bottom-up and top-down row order and the 4-byte row padding.
export function inkShare(bmp: Uint8Array): number {
  if (bmp.length < 54 || bmp[0] !== 0x42 || bmp[1] !== 0x4d) {
    throw new Error("Not a BMP image");
  }
  const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  if (headerSize < 40) throw new Error("Unsupported BMP header");
  const width = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const bitsPerPixel = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const height = Math.abs(signedHeight);
  const topDown = signedHeight < 0;

  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new Error(`Unsupported BMP depth (${bitsPerPixel} bit)`);
  }
  // BI_RGB, or BI_BITFIELDS with the standard BGR layout.
  if (compression !== 0 && compression !== 3) {
    throw new Error(`Unsupported BMP compression (${compression})`);
  }
  if (compression === 3) {
    const masks = [
      view.getUint32(54, true),
      view.getUint32(58, true),
      view.getUint32(62, true),
    ];
    if (masks[0] !== 0xff0000 || masks[1] !== 0xff00 || masks[2] !== 0xff) {
      throw new Error("Unsupported BMP channel layout");
    }
  }
  if (width <= 0 || height <= 0) throw new Error("Empty BMP image");

  const bytesPerPixel = bitsPerPixel / 8;
  const rowSize = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  if (pixelOffset + rowSize * height > bmp.length) {
    throw new Error("BMP pixel data is truncated");
  }

  const x0 = Math.floor(width * MARGIN_X);
  const x1 = width - x0;
  const y0 = Math.floor(height * MARGIN_Y);
  const y1 = height - y0;
  if (x1 <= x0 || y1 <= y0) throw new Error("BMP too small to measure");

  let dark = 0;
  for (let y = y0; y < y1; y++) {
    const row = topDown ? y : height - 1 - y;
    let at = pixelOffset + row * rowSize + x0 * bytesPerPixel;
    for (let x = x0; x < x1; x++, at += bytesPerPixel) {
      const luma = 0.299 * bmp[at + 2] + 0.587 * bmp[at + 1] + 0.114 * bmp[at];
      if (luma < INK_LUMA) dark++;
    }
  }
  return dark / ((x1 - x0) * (y1 - y0));
}

const percent = (share: number, digits: number): string =>
  (share * 100).toFixed(digits);

// `ink: min=0.000% median=0.001% max=0.002% blank=29/29` — the one log line
// per run, for calibrating the thresholds against real batches.
export function inkLogLine(shares: (number | null)[]): string {
  const measured = shares
    .filter((share): share is number => share !== null)
    .sort((a, b) => a - b);
  const blank = measured.filter(isBlankPage).length;
  const unmeasured = shares.length - measured.length;
  const mid = Math.floor(measured.length / 2);
  const median =
    measured.length % 2 === 1
      ? measured[mid]
      : (measured[mid - 1] + measured[mid]) / 2;
  const stats = measured.length
    ? `min=${percent(measured[0], 3)}% median=${percent(median, 3)}% max=${percent(
        measured[measured.length - 1],
        3,
      )}%`
    : "min=n/a median=n/a max=n/a";
  return `ink: ${stats} blank=${blank}/${shares.length}${
    unmeasured ? ` unmeasured=${unmeasured}` : ""
  }`;
}
