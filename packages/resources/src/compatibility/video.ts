// Basic checks for the raw Mode 2 STR stream consumed by port/web/movie.c.
// Compressed frame content and XA audio are not decoded here.
export function validateVideo(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
  const sectorSize = 2352;
  const chunkBytes = 2016;
  if (!bytes.length || bytes.length % sectorSize) throw new Error("Invalid STR sector length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let frame = 1,
    next = 0,
    chunks = 0,
    frameBytes = 0;
  for (let offset = 0; offset < bytes.length; offset += sectorSize) {
    signal?.throwIfAborted();
    const sector = bytes.subarray(offset, offset + sectorSize);
    if (
      sector[0] !== 0 ||
      sector[11] !== 0 ||
      !sector.subarray(1, 11).every((v) => v === 255) ||
      sector[15] !== 2
    )
      throw new Error("Invalid STR Mode 2 sector");
    if (!sector.subarray(16, 20).every((v, i) => v === sector[20 + i]))
      throw new Error("Invalid STR sector subheader");
    const h = offset + 24;
    if (view.getUint16(h, true) !== 0x160 || view.getUint16(h + 2, true) !== 0x8001) continue;
    const chunk = view.getUint16(h + 4, true);
    const total = view.getUint16(h + 6, true);
    const number = view.getUint32(h + 8, true);
    const size = view.getUint32(h + 12, true);
    if (view.getUint16(h + 16, true) !== 320 || view.getUint16(h + 18, true) !== 240)
      throw new Error("STR dimensions are unsupported by the 320×240 movie player");
    if (!next) {
      chunks = total;
      frameBytes = size;
    }
    if (
      !chunks ||
      chunks * chunkBytes > 131072 ||
      !size ||
      size > chunks * chunkBytes ||
      chunk !== next ||
      total !== chunks ||
      number !== frame ||
      size !== frameBytes
    )
      throw new Error("Invalid STR frame chunks");
    if (++next === chunks) {
      next = 0;
      frame++;
    }
  }
  if (next || frame === 1) throw new Error("STR has no complete video stream");
}
