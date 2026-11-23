import { resourceIndex } from "@tm4/mr-preparation";
import { type MrDirectory, readMr } from "@tm4/resources/compatibility/mr";
import type { DiscAssets } from "@tm4/resources/loader/types";
import { binary, directory, writeMr } from "@tm4/resources/mods/mr-writer";

import { type ModPackage, sha256 } from "./package.ts";

export async function assembleMods(
  assets: DiscAssets,
  mods: readonly ModPackage[],
  runtime: string,
) {
  if (!mods.length) return;
  const files = new Map(assets.files);
  const archives = new Map<string, MrDirectory>();
  for (const { manifest, files: payload } of mods) {
    if (manifest.runtime && manifest.runtime !== runtime)
      throw Error(
        `${manifest.name} requires another engine build. Update the mod or disable it in Mods.`,
      );
    for (const { path, sha256: expected } of manifest.base) {
      const data = assets.files.get(path);
      if (!data || (await sha256(data)) !== expected)
        throw Error(
          `${manifest.name} was built from different disc resources (${path}). Rebuild it from this disc.`,
        );
    }
    for (const { path, source } of manifest.mounts) {
      if (files.has(path)) throw Error(`Mod resource already exists: ${path}`);
      files.set(path, payload.get(source)!);
    }
    for (const binding of manifest.registry) {
      const base = files.get(binding.archive);
      if (!base) throw Error(`Missing mod registry archive: ${binding.archive}`);
      let root = archives.get(binding.archive);
      if (!root) {
        root = (await readMr(base)).root;
        archives.set(binding.archive, root);
      }
      for (const name of binding.folder) {
        const existing = findName(root, name);
        if (existing !== undefined && (root.files.has(existing) || existing !== name))
          throw Error(`Conflicting registry folder: ${binding.archive}/${name}`);
        let child = root.folders.get(name);
        if (!child) {
          child = directory();
          root.folders.set(name, child);
        }
        root = child;
      }
      if (findName(root, binding.name) !== undefined)
        throw Error(
          `Mod registry entry already exists: ${binding.archive}/${[...binding.folder, binding.name].join("/")}`,
        );
      const data = payload.get(binding.source)!;
      if (binding.kind === "folder") root.folders.set(binding.name, (await readMr(data)).root);
      else root.files.set(binding.name, binary(data));
    }
  }
  for (const [path, root] of archives) files.set(path, writeMr(root));

  const indexData = files.get("/DATA/files.tsv");
  if (!indexData) throw Error("Missing resource sector index");
  const index = await resourceIndex(new TextDecoder().decode(indexData));
  try {
    const paths = new Set(index.paths());
    for (const [path, bytes] of files) {
      if (paths.has(path)) index.setSize(path, bytes.length);
      else if (path !== "/DATA/files.tsv") index.add(path, 0, bytes.length);
    }
    index.repack(1);
    files.set("/DATA/files.tsv", new TextEncoder().encode(index.toTsv()));
  } finally {
    index.free();
  }
  assets.files = files;
}

function findName(folder: MrDirectory, name: string) {
  const key = name.toLowerCase();
  return [...folder.files.keys(), ...folder.folders.keys()].find(
    (entry) => entry.toLowerCase() === key,
  );
}
