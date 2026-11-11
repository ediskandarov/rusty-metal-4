import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadDisc } from "../../web/src/loader/loader.ts";
import { localSources } from "../../web/src/loader/sources.ts";

const [discDirectory, destination] = process.argv.slice(2);
if (!discDirectory || !destination)
  throw new Error(
    "Usage: bun tools/headless/prepare-resources.ts <local-disc-directory> <output-directory>",
  );
const files = await Promise.all(
  (await readdir(discDirectory))
    .filter((name) => /\.(cue|bin|ccd|img|sub)$/i.test(name))
    .map(async (name) => new File([await Bun.file(join(discDirectory, name)).arrayBuffer()], name)),
);
const assets = await loadDisc(localSources(files));
for (const [path, bytes] of assets.files) {
  const output = join(resolve(destination), path);
  await mkdir(output.slice(0, output.lastIndexOf("/")), { recursive: true });
  await writeFile(output, bytes);
}
console.log(`Prepared ${assets.files.size} private local resources in ${resolve(destination)}`);
