import { readMr } from "./mr.ts";
import type { MrEntry } from "./mr.ts";

export async function validateMainRegistry(
  bytes: Uint8Array<ArrayBuffer>,
  available: ReadonlySet<string>,
  signal?: AbortSignal,
) {
  const { rootName, directories: folders } = await readMr(bytes, signal);
  if (rootName !== "Root") throw new Error("MAIN.MR root must be Root");
  function requireDirectory(path: string) {
    const result = folders.get(path);
    if (!result) throw new Error(`Missing MAIN.MR directory: ${path}`);
    return result;
  }
  function number(entry: MrEntry | undefined, path: string) {
    if (!entry || entry.type !== 4 || entry.bytes.length !== 4)
      throw new Error(`MAIN.MR entry must be a 32-bit number: ${path}`);
  }
  for (const path of ["Root/objects/car/characters", "Root/worlds"]) {
    const collection = requireDirectory(path);
    if (!collection.folders.size) throw new Error(`Empty MAIN.MR directory: ${path}`);
    for (const [childName, child] of collection.folders) {
      const prefix = `${path}/${childName}`;
      const filename = child.files.get("filename");
      if (!filename || filename.type !== 2 || filename.bytes.indexOf(0) <= 0)
        throw new Error(`MAIN.MR entry must be a filename string: ${prefix}/filename`);
      const stem = String.fromCharCode(...filename.bytes.subarray(0, filename.bytes.indexOf(0)));
      if (!available.has(`/DATA/${stem.toUpperCase()}.MR`))
        throw new Error(`Missing resource referenced by MAIN.MR: ${stem}.MR`);
      for (const field of [
        "bioTrackNum",
        "musicTrackNum",
        "numInitialAiCars",
        "numInitialAiCarsRemainingBeforeRegenerating",
        "numTotalAiCars",
        "unlockAt",
      ]) {
        if (child.files.has(field)) number(child.files.get(field), `${prefix}/${field}`);
      }
    }
  }
  const rankings = requireDirectory("Root/rankings");
  if (!rankings.files.size) throw new Error("Empty MAIN.MR rankings");
  for (const [label, entry] of rankings.files) number(entry, `Root/rankings/${label}`);
  // Root/os contains PS1 addresses. The native port resolves those symbols by name.
}
