export interface TimRectangle {
  x: number;
  y: number;
  // TIM stores row widths in 16-bit VRAM words, including for indexed and 24-bit images.
  widthWords: number;
  height: number;
}

export interface TimLayout {
  bitDepth: number;
  image: TimRectangle;
  clut: TimRectangle | null;
}

export function readTimLayout(bytes: Uint8Array<ArrayBuffer>): TimLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint32(0, true) !== 0x10)
    throw new Error("Invalid TIM signature");
  const flags = view.getUint32(4, true);
  const mode = flags & 7;
  if ((flags & ~0xf) !== 0 || mode > 3) throw new Error("Unsupported TIM pixel mode");
  const bitDepth = ([4, 8, 16, 24] as const)[mode]!;
  let offset = 8;
  function block(label: string): TimRectangle {
    if (bytes.length - offset < 12) throw new Error(`Truncated TIM ${label} header`);
    const size = view.getUint32(offset, true);
    const rectangle = {
      x: view.getUint16(offset + 4, true),
      y: view.getUint16(offset + 6, true),
      widthWords: view.getUint16(offset + 8, true),
      height: view.getUint16(offset + 10, true),
    };
    if (!rectangle.widthWords || !rectangle.height) throw new Error(`Empty TIM ${label} rectangle`);
    if (rectangle.x + rectangle.widthWords > 1024 || rectangle.y + rectangle.height > 512)
      throw new Error(`TIM ${label} rectangle exceeds VRAM`);
    if (size !== 12 + rectangle.widthWords * rectangle.height * 2 || size % 4)
      throw new Error(`Invalid TIM ${label} block size`);
    if (size > bytes.length - offset) throw new Error(`Truncated TIM ${label} data`);
    offset += size;
    return rectangle;
  }
  const clut = flags & 8 ? block("CLUT") : null;
  const image = block("image");
  if (offset !== bytes.length) throw new Error("Unexpected data after TIM image");
  return { bitDepth, image, clut };
}

export class TimLayoutMismatch extends Error {}

export function validateTim(bytes: Uint8Array<ArrayBuffer>, expected?: TimLayout) {
  const actual = readTimLayout(bytes);
  if (!expected) return actual;
  if (actual.bitDepth !== expected.bitDepth)
    throw new TimLayoutMismatch(
      `TIM pixel depth changed: expected ${expected.bitDepth}, got ${actual.bitDepth}`,
    );
  if (Boolean(actual.clut) !== Boolean(expected.clut))
    throw new TimLayoutMismatch("TIM CLUT presence changed");
  function compare(label: string, actual: TimRectangle, expected: TimRectangle) {
    for (const field of ["x", "y", "widthWords", "height"] as const) {
      if (actual[field] !== expected[field])
        throw new TimLayoutMismatch(
          `TIM ${label} ${field} changed: expected ${expected[field]}, got ${actual[field]}`,
        );
    }
  }
  compare("image", actual.image, expected.image);
  if (actual.clut && expected.clut) compare("CLUT", actual.clut, expected.clut);
  return actual;
}
