// A minimal PDF writer for scanned pages: one page per JPEG, the JPEG bytes
// embedded untouched (`/DCTDecode`). Pure and binary-safe — everything is
// assembled as byte arrays, never by concatenating strings with image data.

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
}

// Walks the segments to the first SOF0/1/2 frame header.
export function jpegInfo(bytes: Uint8Array): JpegInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Not a JPEG image");
  }
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      throw new Error("Not a JPEG image: broken segment structure");
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Markers without a length: TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI before any frame header
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (i + 9 >= bytes.length) break;
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
      };
    }
    i += 2 + length;
  }
  throw new Error("JPEG has no frame header");
}

export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const { width, height } = jpegInfo(bytes);
  return { width, height };
}

const encoder = new TextEncoder();
const ascii = (text: string): Uint8Array => encoder.encode(text);

const colorSpaceFor = (components: number): string => {
  if (components === 1) return "/DeviceGray";
  if (components === 3) return "/DeviceRGB";
  throw new Error(`Unsupported JPEG with ${components} colour components`);
};

// Points, at most two decimals: 2480 px @ 300 dpi → 595.2.
const points = (pixels: number, dpi: number): string =>
  String(Number(((pixels / dpi) * 72).toFixed(2)));

export function jpegsToPdf(
  pages: { jpeg: Uint8Array; dpi: number }[],
): Uint8Array {
  if (pages.length === 0) throw new Error("A PDF needs at least one page");

  // Object bodies in id order: 1 catalog, 2 page tree, then per page
  // 3 + 3i page, 4 + 3i image, 5 + 3i content stream.
  const bodies: Uint8Array[][] = [];
  const pageIds = pages.map((_, i) => 3 + 3 * i);
  bodies.push([ascii("<< /Type /Catalog /Pages 2 0 R >>")]);
  bodies.push([
    ascii(
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ),
  ]);
  pages.forEach(({ jpeg, dpi }, i) => {
    const { width, height, components } = jpegInfo(jpeg);
    const w = points(width, dpi);
    const h = points(height, dpi);
    const imageId = 4 + 3 * i;
    const contentId = 5 + 3 * i;
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    bodies.push([
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    ]);
    bodies.push([
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpaceFor(components)} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      ascii("\nendstream"),
    ]);
    bodies.push([
      ascii(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    ]);
  });

  const chunks: Uint8Array[] = [
    ascii("%PDF-1.4\n"),
    Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  ];
  let offset = chunks.reduce((sum, c) => sum + c.length, 0);
  const offsets: number[] = [];
  const push = (chunk: Uint8Array): void => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  bodies.forEach((body, index) => {
    offsets.push(offset);
    push(ascii(`${index + 1} 0 obj\n`));
    body.forEach(push);
    push(ascii("\nendobj\n"));
  });

  const xrefAt = offset;
  const entries = offsets.map(
    (o) => `${String(o).padStart(10, "0")} 00000 n \n`,
  );
  push(
    ascii(
      `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${entries.join("")}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    ),
  );

  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
