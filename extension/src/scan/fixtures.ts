// A synthetic JPEG for tests and the fake scanner: SOI, a JFIF APP0 segment,
// a baseline SOF0 header with the given size, EOI. It is not decodable — the
// scan code only ever reads its frame header and embeds the bytes.

export function syntheticJpeg(opts: {
  width: number;
  height: number;
  components?: number;
}): Uint8Array {
  const components = opts.components ?? 3;
  const app0 = [
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ];
  const sofLength = 8 + 3 * components;
  const sof = [
    0xff,
    0xc0,
    sofLength >> 8,
    sofLength & 0xff,
    8,
    opts.height >> 8,
    opts.height & 0xff,
    opts.width >> 8,
    opts.width & 0xff,
    components,
  ];
  for (let i = 1; i <= components; i++) sof.push(i, 0x11, 0);
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}
