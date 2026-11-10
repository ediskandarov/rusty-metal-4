import type { MrDirectory, MrEntry } from "../compatibility/mr.ts";

export function directory(): MrDirectory {
  return { files: new Map(), folders: new Map() };
}
export function binary(bytes: Uint8Array<ArrayBuffer>): MrEntry {
  return { type: 3, arraySize: 65535, bytes };
}
export function stringEntry(value: string): MrEntry {
  const encoded = new TextEncoder().encode(value + "\0");
  const bytes = new Uint8Array(Math.ceil(encoded.length / 4) * 4);
  bytes.set(encoded);
  return { type: 2, arraySize: 65535, bytes };
}
export function stringValue(entry: MrEntry | undefined): string {
  if (!entry || entry.type !== 2) throw new Error("Expected a registry string");
  const end = entry.bytes.indexOf(0);
  if (end < 0) throw new Error("Unterminated registry string");
  return new TextDecoder().decode(entry.bytes.subarray(0, end));
}

// Re-encode decoded payloads, preserving their registry types and array metadata.
export function writeMr(root: MrDirectory): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array<ArrayBuffer>[] = [new Uint8Array([0x67, 0, 0, 0])];
  let total = 4;
  function append(bytes: Uint8Array<ArrayBuffer>) {
    total += bytes.length;
    if (total > 64 * 1024 * 1024) throw new Error("MR output exceeds 64 MiB");
    chunks.push(bytes);
  }
  function nameBytes(name: string) {
    if (!/^[\x20-\x7e]+$/.test(name) || /[/\\]/.test(name)) throw new Error("Invalid MR name");
    const bytes = new TextEncoder().encode(name + "\0");
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    if (padded.length > 252) throw new Error("MR name too long");
    padded.set(bytes);
    return padded;
  }
  function folder(name: string, value: MrDirectory, depth: number) {
    if (depth > 64 || value.folders.size > 255 || value.files.size > 65535)
      throw new Error("MR directory limit exceeded");
    const encoded = nameBytes(name);
    const header = new Uint8Array(4);
    header[0] = encoded.length;
    header[1] = value.folders.size;
    new DataView(header.buffer).setUint16(2, value.files.size, true);
    append(header);
    append(encoded);
    for (const [key, entry] of value.files) {
      const encodedKey = nameBytes(key);
      const header = new Uint8Array(12);
      const view = new DataView(header.buffer);
      header[0] = encodedKey.length;
      header[1] = entry.type;
      view.setUint16(2, entry.arraySize, true);
      view.setUint32(4, entry.bytes.length, true);
      append(header);
      append(encodedKey);
      append(entry.bytes);
    }
    for (const [key, child] of value.folders) folder(key, child, depth + 1);
  }
  folder("Root", root, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
