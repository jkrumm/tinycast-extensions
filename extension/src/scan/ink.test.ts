import { describe, expect, it } from "vitest";
import { InkPorts, measureInk } from "./ink";

// A 100 x 100 24-bit white BMP, optionally with a dark block in the middle.
function bmp(dark: boolean): Uint8Array {
  const rowSize = 300 + 0; // 100 * 3 = 300, already a multiple of 4
  const out = new Uint8Array(54 + rowSize * 100).fill(255);
  const view = new DataView(out.buffer);
  out.fill(0, 0, 54);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 100, true);
  view.setInt32(22, -100, true);
  view.setUint16(28, 24, true);
  if (dark) {
    for (let y = 40; y < 60; y++) {
      out.fill(0, 54 + y * rowSize + 40 * 3, 54 + y * rowSize + 60 * 3);
    }
  }
  return out;
}

function makePorts(files: Record<string, Uint8Array | Error>) {
  const converted: [string, string][] = [];
  const removed: string[] = [];
  const written = new Map<string, Uint8Array>();
  const ports: InkPorts = {
    convert: async (src, dest) => {
      converted.push([src, dest]);
      const file = files[src];
      if (file instanceof Error) throw file;
      written.set(dest, file);
    },
    readFile: (path) => written.get(path)!,
    makeTmpDir: () => "/tmp/ink",
    remove: (path) => void removed.push(path),
  };
  return { ports, converted, removed };
}

describe("measureInk", () => {
  it("converts each page to /tmp/ink/ink-NNN.bmp and measures it", async () => {
    const { ports, converted, removed } = makePorts({
      "/p/page-001.jpg": bmp(false),
      "/p/page-002.jpg": bmp(true),
    });
    const shares = await measureInk(
      ["/p/page-001.jpg", "/p/page-002.jpg"],
      undefined,
      ports,
    );
    expect(shares[0]).toBe(0);
    expect(shares[1]).toBeGreaterThan(0.05);
    expect(converted).toEqual([
      ["/p/page-001.jpg", "/tmp/ink/ink-001.bmp"],
      ["/p/page-002.jpg", "/tmp/ink/ink-002.bmp"],
    ]);
    expect(removed).toContain("/tmp/ink");
  });

  it("gives null, and logs why, for a page sips cannot convert or whose BMP is bad", async () => {
    const { ports } = makePorts({
      "/p/a.jpg": new Error("sips failed"),
      "/p/b.jpg": new Uint8Array(10),
      "/p/c.jpg": bmp(false),
    });
    const logs: string[] = [];
    const shares = await measureInk(
      ["/p/a.jpg", "/p/b.jpg", "/p/c.jpg"],
      (line) => logs.push(line),
      ports,
    );
    expect(shares).toEqual([null, null, 0]);
    expect(logs).toEqual([
      "ink: page 1 not measured: sips failed",
      "ink: page 2 not measured: Not a BMP image",
    ]);
  });
});
