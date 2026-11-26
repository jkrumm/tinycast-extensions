import { describe, expect, it } from "vitest";
import { makeThumbs, ThumbPorts, thumbFileName, thumbIndex } from "./thumbs";

function makePorts(failing: string[] = []) {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const ports: ThumbPorts = {
    convert: async (src, dest) => {
      if (failing.includes(src)) throw new Error("sips failed");
      files.set(dest, Uint8Array.of(src.length));
    },
    readFile: (path) => files.get(path)!,
    makeTmpDir: () => "/tmp/t",
    remove: (path) => void removed.push(path),
  };
  return { ports, removed };
}

describe("makeThumbs", () => {
  it("makes a thumbnail per page, in order, with null for a failed one", async () => {
    const { ports, removed } = makePorts(["/p/bad.jpg"]);
    const logs: string[] = [];
    const result = await makeThumbs(
      ["/p/a.jpg", "/p/bad.jpg", "/p/ccc.jpg"],
      (l) => logs.push(l),
      ports,
    );
    expect(result).toEqual([Uint8Array.of(8), null, Uint8Array.of(10)]);
    expect(logs).toEqual(["thumb: page 2 skipped: sips failed"]);
    expect(removed).toContain("/tmp/t");
  });
});

describe("thumb file names", () => {
  it("carry the page index and a hash of the content", () => {
    const a = thumbFileName(2, Uint8Array.of(1, 2, 3));
    expect(a).toMatch(/^thumb-003-[0-9a-f]{8}\.jpg$/);
    expect(thumbIndex(a)).toBe(2);
    expect(thumbFileName(2, Uint8Array.of(1, 2, 3))).toBe(a);
    expect(thumbFileName(2, Uint8Array.of(9))).not.toBe(a);
    expect(thumbFileName(3, Uint8Array.of(1, 2, 3))).not.toBe(a);
  });

  it("are recognised by thumbIndex only", () => {
    expect(thumbIndex("page-001.jpg")).toBeNull();
    expect(thumbIndex("thumb-001.jpg")).toBeNull();
    expect(thumbIndex("scan.pdf")).toBeNull();
  });
});
