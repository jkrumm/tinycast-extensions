import { describe, expect, it } from "vitest";
import {
  BLANK_INK_SHARE,
  INK_LUMA,
  inkLogLine,
  inkShare,
  isBlankBatch,
  isBlankPage,
} from "./blank";

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

// A BMP built row by row: `pixel(x, y)` with y = 0 at the TOP of the picture.
function makeBmp(opts: {
  width: number;
  height: number;
  bits?: 24 | 32;
  topDown?: boolean;
  pixel: (x: number, y: number) => Rgb;
}): Uint8Array {
  const bits = opts.bits ?? 24;
  const bytesPerPixel = bits / 8;
  const rowSize = Math.floor((bits * opts.width + 31) / 32) * 4;
  const data = new Uint8Array(rowSize * opts.height).fill(0xaa); // padding stays dirty
  for (let y = 0; y < opts.height; y++) {
    const row = opts.topDown ? y : opts.height - 1 - y;
    for (let x = 0; x < opts.width; x++) {
      const [r, g, b] = opts.pixel(x, y);
      const at = row * rowSize + x * bytesPerPixel;
      data[at] = b;
      data[at + 1] = g;
      data[at + 2] = r;
      if (bits === 32) data[at + 3] = 0;
    }
  }
  const out = new Uint8Array(54 + data.length);
  const view = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, opts.width, true);
  view.setInt32(22, opts.topDown ? -opts.height : opts.height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, bits, true);
  view.setUint32(30, 0, true);
  view.setUint32(34, data.length, true);
  out.set(data, 54);
  return out;
}

// 100 x 200: the inner area is x 8..91, y 6..193.
const SIZE = { width: 100, height: 200 };
const block =
  (x0: number, y0: number, x1: number, y1: number) =>
  (x: number, y: number): Rgb =>
    x >= x0 && x < x1 && y >= y0 && y < y1 ? BLACK : WHITE;

describe("inkShare", () => {
  it("is 0 for an all-white page", () => {
    expect(inkShare(makeBmp({ ...SIZE, pixel: () => WHITE }))).toBe(0);
  });

  it("counts a dark block inside the inner area", () => {
    // 20 x 40 px of the 84 x 188 inner area
    const bmp = makeBmp({ ...SIZE, pixel: block(30, 50, 50, 90) });
    expect(inkShare(bmp)).toBeCloseTo(800 / (84 * 188), 10);
  });

  it("ignores dark pixels in the excluded margins", () => {
    // punch holes at the sides, a shadow at top and bottom
    const pixel = (x: number, y: number): Rgb =>
      x < 8 || x >= 92 || y < 6 || y >= 194 ? BLACK : WHITE;
    expect(inkShare(makeBmp({ ...SIZE, pixel }))).toBe(0);
  });

  it("reads bottom-up and top-down files the same", () => {
    const pixel = block(30, 10, 50, 30); // near the TOP of the picture
    const up = inkShare(makeBmp({ ...SIZE, pixel }));
    const down = inkShare(makeBmp({ ...SIZE, pixel, topDown: true }));
    expect(up).toBeGreaterThan(0);
    expect(down).toBe(up);
    // a block only in the top margin is 0 in both orders, proving the row mapping
    const margin = block(30, 0, 50, 5);
    expect(inkShare(makeBmp({ ...SIZE, pixel: margin }))).toBe(0);
    expect(inkShare(makeBmp({ ...SIZE, pixel: margin, topDown: true }))).toBe(
      0,
    );
  });

  it("reads 24 and 32 bit files the same, with and without row padding", () => {
    for (const width of [100, 101, 102, 103]) {
      const pixel = block(30, 50, 50, 90);
      const bmp24 = makeBmp({ width, height: 200, pixel });
      const bmp32 = makeBmp({ width, height: 200, bits: 32, pixel });
      expect(inkShare(bmp24)).toBeGreaterThan(0);
      expect(inkShare(bmp32)).toBe(inkShare(bmp24));
    }
  });

  it("uses luminance, not a channel: dark blue is ink, light yellow is not", () => {
    const blue = inkShare(makeBmp({ ...SIZE, pixel: () => [0, 0, 120] }));
    const yellow = inkShare(makeBmp({ ...SIZE, pixel: () => [255, 255, 0] }));
    expect(blue).toBe(1);
    expect(yellow).toBe(0);
    // either side of the threshold (grey; the weights sum just under 1 in floats)
    const at = (g: number) =>
      inkShare(makeBmp({ ...SIZE, pixel: () => [g, g, g] }));
    expect(at(INK_LUMA - 1)).toBe(1);
    expect(at(INK_LUMA + 1)).toBe(0);
  });

  it("throws on anything that is not an uncompressed 24 or 32 bit BMP", () => {
    expect(() => inkShare(new Uint8Array(100))).toThrow(/Not a BMP/);
    const good = makeBmp({ ...SIZE, pixel: () => WHITE });

    const bits8 = good.slice();
    new DataView(bits8.buffer).setUint16(28, 8, true);
    expect(() => inkShare(bits8)).toThrow(/depth/);

    const rle = good.slice();
    new DataView(rle.buffer).setUint32(30, 1, true);
    expect(() => inkShare(rle)).toThrow(/compression/);

    expect(() => inkShare(good.slice(0, good.length - 100))).toThrow(
      /truncated/,
    );
  });
});

describe("blank thresholds", () => {
  it("calls a page blank below BLANK_INK_SHARE", () => {
    expect(isBlankPage(0)).toBe(true);
    expect(isBlankPage(BLANK_INK_SHARE / 2)).toBe(true);
    expect(isBlankPage(BLANK_INK_SHARE)).toBe(false);
    expect(isBlankPage(0.03)).toBe(false);
  });

  it("calls a batch blank only when every page was measured and is blank", () => {
    expect(isBlankBatch([0, 0.0001, 0])).toBe(true);
    expect(isBlankBatch([0, 0.02, 0])).toBe(false);
    expect(isBlankBatch([0, null, 0])).toBe(false);
    expect(isBlankBatch([])).toBe(false);
  });
});

describe("inkLogLine", () => {
  it("prints min, median, max as percentages and the blank count", () => {
    expect(inkLogLine([0.0001, 0.02, 0, 0.5])).toBe(
      "ink: min=0.000% median=1.005% max=50.000% blank=2/4",
    );
  });

  it("says how many pages could not be measured", () => {
    expect(inkLogLine([0, null])).toBe(
      "ink: min=0.000% median=0.000% max=0.000% blank=1/2 unmeasured=1",
    );
    expect(inkLogLine([null])).toBe(
      "ink: min=n/a median=n/a max=n/a blank=0/1 unmeasured=1",
    );
  });
});
