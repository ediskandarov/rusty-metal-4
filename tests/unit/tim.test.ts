import { expect, test } from "bun:test";

import {
  checkResource,
  checkResources,
  compatibilityReport,
  readTimLayout,
  resourceReference,
  resourceRows,
  sha256,
  validateTim,
} from "../../web/src/compatibility/index.ts";
import type { TimRectangle } from "../../web/src/compatibility/index.ts";

const image: TimRectangle = { x: 320, y: 0, widthWords: 6, height: 2 };
const palette: TimRectangle = { x: 0, y: 480, widthWords: 256, height: 1 };
function tim(mode = 2, pixels = image, clut: TimRectangle | null = null) {
  const block = (rectangle: TimRectangle) => {
    const bytes = new Uint8Array(12 + rectangle.widthWords * rectangle.height * 2);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length, true);
    view.setUint16(4, rectangle.x, true);
    view.setUint16(6, rectangle.y, true);
    view.setUint16(8, rectangle.widthWords, true);
    view.setUint16(10, rectangle.height, true);
    return bytes;
  };
  const parts = clut ? [block(clut), block(pixels)] : [block(pixels)];
  const bytes = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.length, 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x10, true);
  view.setUint32(4, mode | (clut ? 8 : 0), true);
  let offset = 8;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

test("TIM reads 4/8/16/24-bit layouts in VRAM words and respects subarray offsets", () => {
  for (const [mode, bitDepth] of [4, 8, 16, 24].entries()) {
    const clut = mode < 2 ? { ...palette, widthWords: mode ? 256 : 16 } : null;
    const bytes = tim(mode, image, clut);
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 5);
    expect(readTimLayout(padded.subarray(5, 5 + bytes.length))).toEqual({ bitDepth, image, clut });
  }
});

test("TIM pixel and palette colors may change, including transparency bits", () => {
  const original = tim(1, image, palette);
  const changed = original.slice();
  changed[20] = 0xff;
  changed[21] = 0xff;
  changed[changed.length - 1] = 0x80;
  expect(validateTim(changed, readTimLayout(original))).toEqual(readTimLayout(original));
  const direct = tim();
  const directChanged = direct.slice();
  directChanged[20] = 0x7f;
  expect(validateTim(directChanged, readTimLayout(direct))).toEqual(readTimLayout(direct));
});

test("TIM rejects changed image dimensions, placement, mode and CLUT presence", () => {
  const expected = readTimLayout(tim());
  for (const field of ["x", "y", "widthWords", "height"] as const) {
    const changed = { ...image, [field]: image[field] + 2 };
    expect(() => validateTim(tim(2, changed), expected)).toThrow(`image ${field} changed`);
  }
  expect(() => validateTim(tim(3), expected)).toThrow("pixel depth changed");
  expect(() => validateTim(tim(2, image, palette), expected)).toThrow("CLUT presence changed");
  expect(() => validateTim(tim(1), readTimLayout(tim(1, image, palette)))).toThrow(
    "CLUT presence changed",
  );
});

test("TIM rejects changed palette dimensions and placement", () => {
  const expected = readTimLayout(tim(1, image, palette));
  for (const field of ["x", "y", "widthWords", "height"] as const) {
    const changed = { ...palette, [field]: palette[field] + 2 };
    expect(() => validateTim(tim(1, image, changed), expected)).toThrow(`CLUT ${field} changed`);
  }
});

test("TIM rejects invalid headers, truncated blocks, inconsistent sizes and VRAM overflow", () => {
  for (const length of [0, 7, 10, 19, tim().length - 1])
    expect(() => readTimLayout(tim().subarray(0, length))).toThrow();
  const signature = tim();
  signature[0] = 1;
  expect(() => readTimLayout(signature)).toThrow("signature");
  const flags = tim();
  flags[4] = 0x10;
  expect(() => readTimLayout(flags)).toThrow("mode");
  expect(() => readTimLayout(tim(4))).toThrow("mode");
  const size = tim();
  new DataView(size.buffer).setUint32(8, 0xffffffff, true);
  expect(() => readTimLayout(size)).toThrow("block size");
  expect(() => readTimLayout(tim(2, { ...image, widthWords: 0 }))).toThrow("Empty");
  expect(() => readTimLayout(tim(2, { ...image, x: 1023 }))).toThrow("exceeds VRAM");
  expect(() => readTimLayout(tim(2, image, { ...palette, y: 512 }))).toThrow("exceeds VRAM");
  const trailing = new Uint8Array(tim().length + 4);
  trailing.set(tim());
  expect(() => readTimLayout(trailing)).toThrow("Unexpected data");
});

test("TIM metadata is available for every reference TIM, without pixel or palette content", () => {
  const images = resourceReference.filter((file) => file.id.endsWith(".TIM"));
  expect(images.length).toBeGreaterThan(0);
  for (const file of images) {
    expect(file.tim).toBeDefined();
    expect(Object.keys(file.tim!).sort()).toEqual(["bitDepth", "clut", "image"]);
    expect(Object.keys(file.tim!.image).sort()).toEqual(["height", "widthWords", "x", "y"]);
  }
});

test("loader and resource audit agree: repaint is compatible, layout change only warns", async () => {
  const id = "/DATA/TEST.TIM";
  const original = tim(1, image, palette);
  const reference = {
    id,
    size: original.length,
    sha256: await sha256(original),
    tim: readTimLayout(original),
  };
  const repaint = original.slice();
  repaint[20] = 42;
  const moved = tim(1, { ...image, x: 322 }, palette);
  const available = new Set([id]);
  for (const [bytes, status] of [
    [original, "compatible"],
    [repaint, "compatible"],
    [moved, "warning"],
  ] as const) {
    const found = [{ id, size: bytes.length, read: () => Promise.resolve(bytes) }];
    const rows = resourceRows(found, [reference]);
    await checkResources(found, rows, new AbortController().signal, () => {});
    expect(compatibilityReport(rows).status).toBe(status);
    const result = await checkResource({ id, bytes, available, reference });
    expect(result.status).toBe(status);
    expect(rows[0]?.message).toBe(result.message);
  }
  expect((await checkResource({ id, bytes: original, available })).status).toBe("warning");
  expect(
    (await checkResource({ id, bytes: new Uint8Array([1, 2, 3]), available, reference })).status,
  ).toBe("uncompatible");
});
