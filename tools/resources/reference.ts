import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import discReference from "../../config/disc.json";
import { discoverResources } from "../../web/src/loader/resources.ts";
import { checkRange } from "../../web/src/loader/sources.ts";
import { sha256, verifyExecutable } from "../../web/src/loader/verify.ts";

const directory = process.argv[2];
if (!directory)
  throw new Error("Usage: bun tools/resources/reference.ts <original-disc-directory>");
const sources = new Map(
  (await readdir(directory))
    .filter((name) => /\.(bin|cue)$/i.test(name))
    .map((name) => {
      const file = Bun.file(resolve(directory, name));
      return [
        name.toLowerCase(),
        {
          name,
          size: file.size,
          async read(offset: number, length: number) {
            checkRange(file.size, offset, length);
            return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
          },
        },
      ];
    }),
);
const signal = new AbortController().signal;
const { resources } = await discoverResources(sources, signal);
const exe = resources.find((resource) => resource.id === "/SCUS_945.60");
if (!exe?.read) throw new Error("Original executable missing");
await verifyExecutable(await exe.read(signal), discReference.executable.sha256);
// Bind reference generation to the known full dump, not merely an unchanged EXE.
for (const expected of discReference.files) {
  const source = sources.get(expected.name.toLowerCase());
  if (!source || source.size !== expected.size)
    throw new Error(`Missing original track: ${expected.name}`);
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(resolve(directory, source.name)).stream()) hash.update(chunk);
  if (hash.digest("hex") !== expected.sha256)
    throw new Error(`Modified reference track: ${source.name}`);
}
const files = [];
for (const resource of resources) {
  if (resource.id === "/SCUS_945.60") continue; // Its authoritative hash stays in disc.json.
  files.push({
    id: resource.id,
    size: resource.size,
    sha256: await sha256(await resource.read!(signal)),
  });
}
files.sort((a, b) => a.id.localeCompare(b.id));
await Bun.write(
  new URL("../../config/resources.json", import.meta.url),
  JSON.stringify({ files }, null, 2) + "\n",
);
console.log(`Recorded ${files.length} resource checksums; no disc content or source paths stored.`);
