import type { DiscSource, ReadOptions } from "./types.ts";
interface DiscRecord {
  lba: number;
  size: number;
  directory: boolean;
  name: string;
}
export interface DiscEntry extends DiscRecord {
  path: string;
}
import { RAW_SECTOR } from "./tracks.ts";
export const DATA_SECTOR = 2048;
const decoder = new TextDecoder("ascii", { fatal: true });
const sectorCount = (size: number) => Math.ceil(size / DATA_SECTOR);
export class Disc {
  constructor(
    public readonly source: DiscSource,
    public readonly index = 0,
  ) {
    this.source = source;
    this.index = index;
  }
  async raw(lba: number, size: number, options?: ReadOptions) {
    return this.source.read(
      (this.index + lba) * RAW_SECTOR,
      sectorCount(size) * RAW_SECTOR,
      options,
    );
  }
  async read(lba: number, size: number, options?: ReadOptions) {
    options?.signal?.throwIfAborted();
    const output = new Uint8Array(size);
    // Read contiguous chunks: HTTP ranges and local File slices use the same path.
    for (let first = 0; first < sectorCount(size); first += 512) {
      options?.signal?.throwIfAborted();
      const count = Math.min(512, sectorCount(size) - first);
      const bytes = await this.source.read(
        (this.index + lba + first) * RAW_SECTOR,
        count * RAW_SECTOR,
        options,
      );
      options?.signal?.throwIfAborted();
      for (let i = 0; i < count; i++) {
        const sector = bytes.subarray(i * RAW_SECTOR, (i + 1) * RAW_SECTOR);
        if (
          sector[0] ||
          sector[11] ||
          !sector.subarray(1, 11).every((b) => b === 255) ||
          sector[15] !== 2 ||
          !sector.subarray(16, 20).every((b, j) => b === sector[20 + j]) ||
          sector[18]! & 0x20
        )
          throw new Error(`Invalid Mode 2 Form 1 data sector: ${lba + first + i}`);
        const offset = (first + i) * DATA_SECTOR;
        output.set(sector.subarray(24, 24 + Math.min(DATA_SECTOR, size - offset)), offset);
      }
    }
    return output;
  }
  record(bytes: Uint8Array): DiscRecord {
    if (bytes.length < 34 || 33 + bytes[32]! > bytes.length)
      throw new Error("Truncated ISO directory record");
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const lba = data.getUint32(2, true),
      size = data.getUint32(10, true);
    if (
      lba !== data.getUint32(6, false) ||
      size !== data.getUint32(14, false) ||
      bytes[26] ||
      bytes[27] ||
      bytes[25]! & 128
    )
      throw new Error("Unsupported ISO record layout");
    return {
      lba,
      size,
      directory: !!(bytes[25]! & 2),
      name: decoder.decode(bytes.subarray(33, 33 + bytes[32]!)),
    };
  }
  async entries(options?: ReadOptions) {
    const pvd = await this.read(16, DATA_SECTOR, options);
    if (decoder.decode(pvd.subarray(0, 7)) !== "\x01CD001\x01")
      throw new Error("Not a supported ISO 9660 data track");
    const root = this.record(pvd.subarray(156, 156 + pvd[156]!));
    const visited = new Set(),
      entries: DiscEntry[] = [];
    const walk = async (directory: DiscRecord, path: string, depth: number): Promise<void> => {
      if (
        depth > 16 ||
        visited.has(directory.lba) ||
        visited.size > 4096 ||
        directory.size > 16 * 1024 * 1024
      )
        throw new Error("Invalid ISO directory tree");
      visited.add(directory.lba);
      const bytes = await this.read(directory.lba, directory.size, options);
      for (let offset = 0; offset < bytes.length;) {
        const length = bytes[offset]!;
        if (!length) {
          offset = (Math.floor(offset / DATA_SECTOR) + 1) * DATA_SECTOR;
          continue;
        }
        if (offset + length > bytes.length || (offset % DATA_SECTOR) + length > DATA_SECTOR)
          throw new Error("Invalid ISO record boundary");
        const record = this.record(bytes.subarray(offset, offset + length));
        offset += length;
        if (record.name === "\0" || record.name === "\x01") continue;
        if (
          [...record.name].some(
            (char) => char.charCodeAt(0) < 32 || char === "/" || char === "\\",
          ) ||
          record.name === "." ||
          record.name === ".."
        )
          throw new Error("Invalid ISO file name");
        const name = record.name.replace(/;\d+$/, "");
        const entry = { ...record, path: `${path}/${name}` };
        if (record.directory) await walk(entry, entry.path, depth + 1);
        else entries.push(entry);
      }
    };
    await walk(root, "", 0);
    if (new Set(entries.map((e) => e.path.toUpperCase())).size !== entries.length)
      throw new Error("Duplicate ISO files");
    return entries;
  }
}
