import type { DiscSource, DiscSources, ReadOptions } from "./types.ts";
export function fileKey(name: string) {
  if (
    !name ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char === "/" || char === "\\") ||
    name === "." ||
    name === ".."
  )
    throw new Error(`Invalid disc file name: ${name}`);
  return name.toLowerCase();
}
export function checkRange(size: number, offset: number, length: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > size
  )
    throw new Error(`Read outside disc file (${offset} + ${length} > ${size})`);
}
// A track may share a BIN with other tracks and have a CUE-generated silent pregap.
export function trackSource(
  source: DiscSource,
  offset: number,
  length: number,
  silence = 0,
): DiscSource {
  checkRange(source.size, offset, length);
  if (!Number.isSafeInteger(silence) || silence < 0 || !Number.isSafeInteger(length + silence))
    throw new Error("Invalid track pregap");
  return {
    name: source.name,
    size: length + silence,
    async read(at, count, options = {}) {
      checkRange(length + silence, at, count);
      options.signal?.throwIfAborted();
      const silentBytes = Math.min(count, Math.max(0, silence - at));
      if (silentBytes === count) return new Uint8Array(count);
      const chunk = await source.read(
        offset + Math.max(0, at - silence),
        count - silentBytes,
        options,
      );
      options.signal?.throwIfAborted();
      if (chunk.length !== count - silentBytes) throw new Error(`Truncated track: ${source.name}`);
      if (!silentBytes) return chunk;
      const bytes = new Uint8Array(count);
      bytes.set(chunk, silentBytes);
      return bytes;
    },
  };
}
function index(sources: DiscSource[]): DiscSources {
  const map: DiscSources = new Map();
  for (const source of sources) {
    const key = fileKey(source.name);
    if (map.has(key)) throw new Error(`Duplicate disc file: ${source.name}`);
    map.set(key, source);
  }
  return map;
}
export function localSources(files: Iterable<File>) {
  return index(
    [...files].map((file) => ({
      name: file.name,
      size: file.size,
      async read(offset: number, length: number, { signal }: ReadOptions = {}) {
        checkRange(file.size, offset, length);
        signal?.throwIfAborted();
        const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        signal?.throwIfAborted();
        return bytes;
      },
    })),
  );
}
export function directorySources(files: Iterable<File>) {
  const tracks = [...files].filter((file) => /\.(cue|bin)$/i.test(file.name));
  if (!tracks.length) throw new Error("No CUE or BIN files found in this folder");
  return localSources(tracks);
}
export async function remoteSources(url: string, { signal }: ReadOptions = {}) {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Disc server: HTTP ${response.status}`);
  const manifest = parseManifest(await response.json());
  const base = new URL(url, location.href);
  const sources = manifest.files.map((file) => {
    const sourceURL = new URL(file.url, base);
    if (sourceURL.origin !== base.origin)
      throw new Error("Disc file URL must use the local server");
    if (!Number.isSafeInteger(file.size) || file.size < 0)
      throw new Error("Invalid remote file size");
    return {
      name: file.name,
      size: file.size,
      async read(offset: number, length: number, { signal }: ReadOptions = {}) {
        checkRange(file.size, offset, length);
        if (!length) return new Uint8Array();
        const response = await fetch(sourceURL, {
          signal,
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        });
        if (
          response.status !== 206 ||
          response.headers.get("Content-Range") !==
            `bytes ${offset}-${offset + length - 1}/${file.size}`
        )
          throw new Error(`Invalid range response for ${file.name}: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== length) throw new Error(`Truncated download: ${file.name}`);
        return bytes;
      },
    };
  });
  return { sources: index(sources), warnings: manifest.warnings ?? [] };
}

interface RemoteFile {
  name: string;
  size: number;
  url: string;
}
interface RemoteManifest {
  files: RemoteFile[];
  warnings: string[];
}
function parseManifest(value: unknown): RemoteManifest {
  if (!value || typeof value !== "object" || !("files" in value) || !Array.isArray(value.files))
    throw new Error("Invalid disc server manifest");
  const files: RemoteFile[] = value.files.map((file: unknown) => {
    if (
      !file ||
      typeof file !== "object" ||
      !("name" in file) ||
      typeof file.name !== "string" ||
      !("size" in file) ||
      typeof file.size !== "number" ||
      !("url" in file) ||
      typeof file.url !== "string"
    )
      throw new Error("Invalid disc server file");
    return { name: file.name, size: file.size, url: file.url };
  });
  const warnings = "warnings" in value && Array.isArray(value.warnings) ? value.warnings : [];
  if (!warnings.every((warning: unknown) => typeof warning === "string"))
    throw new Error("Invalid server warnings");
  return { files, warnings };
}
