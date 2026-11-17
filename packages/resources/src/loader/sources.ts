import { openDisc } from "@tm4/dev-server-client";

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
// Expose a bounded file range with optional silent pregap and final-sector padding.
export function trackSource(
  source: DiscSource,
  offset: number,
  length: number,
  silence = 0,
  trailingSilence = 0,
): DiscSource {
  checkRange(source.size, offset, length);
  const size = silence + length + trailingSilence;
  if (
    !Number.isSafeInteger(silence) ||
    silence < 0 ||
    !Number.isSafeInteger(trailingSilence) ||
    trailingSilence < 0 ||
    !Number.isSafeInteger(size)
  )
    throw new Error("Invalid track padding");
  return {
    name: source.name,
    size,
    async read(at, count, options = {}) {
      checkRange(size, at, count);
      options.signal?.throwIfAborted();
      const begin = Math.max(at, silence);
      const end = Math.min(at + count, silence + length);
      if (end <= begin) return new Uint8Array(count);
      const chunk = await source.read(offset + begin - silence, end - begin, options);
      options.signal?.throwIfAborted();
      if (chunk.length !== end - begin) throw new Error(`Truncated track: ${source.name}`);
      if (chunk.length === count) return chunk;
      const bytes = new Uint8Array(count);
      bytes.set(chunk, begin - at);
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
  const tracks = [...files].filter((file) => /\.(cue|bin|ccd|img|sub)$/i.test(file.name));
  if (!tracks.length) throw new Error("No CUE, BIN, CCD or IMG files found in this folder");
  return localSources(tracks);
}
export async function remoteSources(url: URL, { signal }: ReadOptions = {}) {
  const manifest = await openDisc(url, signal);
  return { sources: index(manifest.files), warnings: manifest.warnings };
}
