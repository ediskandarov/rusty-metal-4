export interface MrEntry {
  type: number;
  arraySize: number;
  bytes: Uint8Array<ArrayBuffer>;
}
export interface MrDirectory {
  files: Map<string, MrEntry>;
  folders: Map<string, MrDirectory>;
}

const maxExpandedBytes = 64 * 1024 * 1024;

async function inflateExact(bytes: Uint8Array<ArrayBuffer>, size: number, signal?: AbortSignal) {
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  const output = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > size) throw new Error("Oversized compressed entry");
      output.set(value, offset);
      offset += value.length;
    }
    if (offset !== size) throw new Error("Truncated compressed entry");
    return output;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function inflate(bytes: Uint8Array<ArrayBuffer>, size: number, signal?: AbortSignal) {
  let failure: Error | undefined;
  // MR stored lengths may include up to three alignment bytes after the zlib stream.
  for (let padding = 0; padding <= Math.min(3, bytes.length - 1); padding++) {
    signal?.throwIfAborted();
    try {
      return await inflateExact(bytes.subarray(0, bytes.length - padding), size, signal);
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  signal?.throwIfAborted();
  throw failure ?? new Error("Empty compressed MR entry");
}

// Container validation only: entry types and payload semantics belong to resource-specific checks.
export async function readMr(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let expanded = 0;
  const folders = new Map<string, MrDirectory>();
  function take(size: number) {
    if (size > bytes.length - offset) throw new Error("Truncated MR entry");
    const start = offset;
    offset += size;
    return start;
  }
  function name(size: number) {
    if (!size || size % 4) throw new Error("Invalid MR name length");
    const data = bytes.subarray(take(size), offset);
    const end = data.indexOf(0);
    if (end <= 0) throw new Error("Invalid MR name");
    return String.fromCharCode(...data.subarray(0, end));
  }
  async function directory(parent: string, depth: number): Promise<[string, MrDirectory]> {
    signal?.throwIfAborted();
    if (depth > 64) throw new Error("MR nesting limit exceeded");
    const header = take(4);
    const folderName = name(view.getUint8(header));
    if (folderName.includes("/")) throw new Error("Invalid MR directory name");
    const path = parent ? `${parent}/${folderName}` : folderName;
    if (folders.has(path)) throw new Error(`Duplicate MR directory: ${path}`);
    const result: MrDirectory = { files: new Map(), folders: new Map() };
    folders.set(path, result);
    const fileCount = view.getUint16(header + 2, true);
    const folderCount = view.getUint8(header + 1);
    for (let i = 0; i < fileCount; i++) {
      signal?.throwIfAborted();
      const entry = take(12);
      const fileName = name(view.getUint8(entry));
      if (result.files.has(fileName)) throw new Error(`Duplicate MR entry: ${path}/${fileName}`);
      const stored = view.getUint32(entry + 4, true);
      const unpacked = view.getUint32(entry + 8, true);
      expanded += unpacked || stored;
      if (expanded > maxExpandedBytes) throw new Error("MR expanded size limit exceeded");
      const payload = bytes.subarray(take(stored), offset);
      result.files.set(fileName, {
        type: view.getUint8(entry + 1),
        arraySize: view.getUint16(entry + 2, true),
        bytes: unpacked ? await inflate(payload, unpacked, signal) : payload,
      });
    }
    for (let i = 0; i < folderCount; i++) {
      const [childName, child] = await directory(path, depth + 1);
      result.folders.set(childName, child);
    }
    return [folderName, result];
  }
  take(4);
  const magic = view.getUint32(0, true);
  if (magic !== 0xcccc0067 && magic !== 0x00000067) throw new Error("Invalid MR signature");
  const [rootName, root] = await directory("", 0);
  if (bytes.subarray(offset).some((byte) => ![0, 0xcc, 0xcd, 0xfd].includes(byte)))
    throw new Error("Unexpected data after MR root");

  return { rootName, root, directories: folders };
}
