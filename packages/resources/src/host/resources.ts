import { isAbsolute, relative, resolve, sep } from "node:path";

import { readTimLayout, sha256 } from "../compatibility/index.ts";
import type { ResourceReference } from "../compatibility/index.ts";
import { type DiscLoaderOptions, loadDisc } from "../loader/loader.ts";
import { discoverResources } from "../loader/resources.ts";
import type { DiscReference } from "../loader/types.ts";
import { discDirectorySources, inspectDisc } from "./disc.ts";
import type { DiscFileReference } from "./disc.ts";

// Reference generation deliberately requires the known full dump, unlike normal loading.
export async function generateResourceReference(
  directory: string,
  reference: DiscReference & DiscFileReference,
  signal = new AbortController().signal,
): Promise<{ files: ResourceReference[] }> {
  signal.throwIfAborted();
  const inspected = await inspectDisc(directory, reference, { signal });
  const sources = new Map(inspected.files.map((file) => [file.name.toLowerCase(), file]));
  for (const expected of reference.files) {
    const source = sources.get(expected.name.toLowerCase());
    if (!source || source.size !== expected.size)
      throw new Error(`Missing original track: ${expected.name}`);
    if (source.sha256 !== expected.sha256)
      throw new Error(`Modified reference track: ${source.name}`);
  }
  const { resources } = await discoverResources(sources, signal, reference);
  const exe = resources.find((resource) => resource.id === "/SCUS_945.60");
  if (!exe?.read) throw new Error("Original executable missing");
  if ((await sha256(await exe.read(signal))) !== reference.executable.sha256)
    throw new Error("Original executable checksum mismatch");
  const files: ResourceReference[] = [];
  for (const resource of resources) {
    signal.throwIfAborted();
    if (resource.id === "/SCUS_945.60") continue;
    const bytes = await resource.read!(signal);
    files.push({
      id: resource.id,
      size: resource.size,
      sha256: await sha256(bytes),
      ...(resource.id.endsWith(".TIM") ? { tim: readTimLayout(bytes) } : {}),
    });
  }
  files.sort((a, b) => a.id.localeCompare(b.id));
  return { files };
}

export async function writeResourceFiles(
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  destination: string,
) {
  const root = resolve(destination);
  for (const [path, bytes] of files) {
    // Loader IDs are disc-root-relative, with a leading slash.
    const output = resolve(root, path.replace(/^\/+/, ""));
    const child = relative(root, output);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error(`Resource path escapes its destination: ${path}`);
    await Bun.write(output, bytes);
  }
}

export async function prepareResources(
  directory: string,
  destination: string,
  options: DiscLoaderOptions = {},
) {
  const assets = await loadDisc(await discDirectorySources(directory), options);
  await writeResourceFiles(assets.files, destination);
  return assets.files.size;
}
