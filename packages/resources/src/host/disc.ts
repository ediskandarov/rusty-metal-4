import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { BunFile } from "bun";

import { checkRange, fileKey } from "../loader/sources.ts";
import type { DiscSource, ReadOptions } from "../loader/types.ts";

export interface DiscFileReference {
  files: { name: string; size: number; sha256: string }[];
}

export interface LocalDiscSource extends DiscSource {
  file: BunFile;
}

function outside(root: string, path: string) {
  const child = relative(root, path);
  return child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child);
}

// Bun files retain random access to tracks, including large images and optional media.
export async function discDirectorySources(
  directory: string,
): Promise<Map<string, LocalDiscSource>> {
  const root = await realpath(directory);
  const sources = new Map<string, LocalDiscSource>();
  const names = (await readdir(root))
    .filter((name) => /\.(cue|bin|ccd|img|sub)$/i.test(name))
    .sort();
  for (const name of names) {
    const key = fileKey(name);
    if (sources.has(key)) throw new Error(`Duplicate disc file: ${name}`);
    const path = await realpath(resolve(root, name));
    if (outside(root, path)) throw new Error(`Disc file escapes its directory: ${name}`);
    const file = Bun.file(path);
    sources.set(key, {
      name,
      size: file.size,
      file,
      async read(offset: number, length: number, { signal }: ReadOptions = {}) {
        checkRange(file.size, offset, length);
        signal?.throwIfAborted();
        const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        signal?.throwIfAborted();
        if (bytes.length !== length) throw new Error(`Truncated disc file: ${name}`);
        return bytes;
      },
    });
  }
  return sources;
}

export interface InspectedDiscFile extends LocalDiscSource {
  sha256: string;
  matchesReference: boolean;
}

// Identity warnings do not decide resource compatibility; the loader checks that separately.
export async function inspectDisc(
  directory: string,
  reference: DiscFileReference,
  { signal }: ReadOptions = {},
) {
  signal?.throwIfAborted();
  const sources = await discDirectorySources(directory);
  if (![...sources.values()].some(({ name }) => /\.(bin|img)$/i.test(name)))
    throw new Error("No BIN or IMG files in the disc directory");
  const files: InspectedDiscFile[] = [];
  const warnings: string[] = [];
  for (const source of sources.values()) {
    const hash = new Bun.CryptoHasher("sha256");
    for await (const chunk of source.file.stream()) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    signal?.throwIfAborted();
    const sha256 = hash.digest("hex");
    const expected = reference.files.find(
      (entry) => entry.name.toLowerCase() === source.name.toLowerCase(),
    );
    const matchesReference = expected?.sha256 === sha256;
    if (!matchesReference)
      warnings.push(
        `Modified or unrecognized disc file: ${source.name}. Resource compatibility will be checked in the browser.`,
      );
    files.push({ ...source, sha256, matchesReference });
  }
  for (const expected of reference.files) {
    if (!sources.has(expected.name.toLowerCase()))
      warnings.push(`Missing disc file: ${expected.name}`);
  }
  return { files, warnings };
}
