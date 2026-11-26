import { describe, expect, it } from "vitest";
import { syntheticJpeg } from "./fixtures";
import { jpegSize, jpegsToPdf } from "./pdf";

const text = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("latin1");

describe("jpegSize", () => {
  it("reads the frame header past other segments", () => {
    expect(jpegSize(syntheticJpeg({ width: 2480, height: 3508 }))).toEqual({
      width: 2480,
      height: 3508,
    });
  });

  it("throws on something that is not a JPEG", () => {
    expect(() => jpegSize(new TextEncoder().encode("%PDF-1.4"))).toThrow(
      /Not a JPEG/,
    );
    expect(() => jpegSize(new Uint8Array())).toThrow(/Not a JPEG/);
  });

  it("throws when there is no frame header", () => {
    expect(() => jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow(
      /no frame header/,
    );
  });
});

describe("jpegsToPdf", () => {
  const rgb = syntheticJpeg({ width: 2480, height: 3508 });
  const gray = syntheticJpeg({ width: 600, height: 300, components: 1 });
  const pdf = jpegsToPdf([
    { jpeg: rgb, dpi: 300 },
    { jpeg: gray, dpi: 300 },
    { jpeg: rgb, dpi: 300 },
  ]);
  const body = text(pdf);

  it("is a PDF 1.4 document", () => {
    expect(body.startsWith("%PDF-1.4")).toBe(true);
    expect(body.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("has one page object per JPEG", () => {
    expect(body.match(/\/Type \/Page\b/g)).toHaveLength(3);
    expect(body).toContain("/Count 3");
  });

  it("sizes the MediaBox from pixels and dpi", () => {
    expect(body).toContain("/MediaBox [0 0 595.2 841.92]");
    expect(body).toContain("q 595.2 0 0 841.92 0 0 cm /Im0 Do Q");
    expect(body).toContain("/MediaBox [0 0 144 72]");
  });

  it("embeds the JPEGs untouched with the colour space of their components", () => {
    expect(body.match(/\/Filter \/DCTDecode/g)).toHaveLength(3);
    expect(body.match(/\/ColorSpace \/DeviceRGB/g)).toHaveLength(2);
    expect(body.match(/\/ColorSpace \/DeviceGray/g)).toHaveLength(1);
    expect(body.match(/\/BitsPerComponent 8/g)).toHaveLength(3);
    expect(body).toContain(text(rgb));
  });

  it("has an xref table whose offsets point at the objects they name", () => {
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(body)?.[1]);
    expect(body.slice(startxref, startxref + 4)).toBe("xref");
    const section = body.slice(startxref).split("\n");
    const [first, count] = section[1].split(" ").map(Number);
    expect(first).toBe(0);
    expect(count).toBe(1 + 2 + 3 * 3);
    expect(section[2]).toBe("0000000000 65535 f ");
    for (let id = 1; id < count; id++) {
      const entry = section[2 + id];
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      const offset = Number(entry.slice(0, 10));
      expect(body.slice(offset, offset + `${id} 0 obj`.length)).toBe(
        `${id} 0 obj`,
      );
    }
    expect(body).toContain(`/Size ${count} /Root 1 0 R`);
  });

  it("refuses an empty page list and a non-JPEG page", () => {
    expect(() => jpegsToPdf([])).toThrow();
    expect(() => jpegsToPdf([{ jpeg: new Uint8Array(8), dpi: 300 }])).toThrow(
      /Not a JPEG/,
    );
  });
});
