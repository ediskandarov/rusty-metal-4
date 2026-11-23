import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256 } from "@tm4/mods";
import { converterReleaseSchema } from "@tm4/mods/recipe";

export async function installConverter(source: string, site: string, runtime: string) {
  const manifest = new Uint8Array(await Bun.file(join(source, "release.json")).arrayBuffer());
  const release = converterReleaseSchema.parse(JSON.parse(new TextDecoder().decode(manifest)));
  if (release.runtime !== runtime)
    throw Error("The TM3 converter targets a different player runtime");
  const paths = new Set(release.files.map(({ path }) => path));
  if (!paths.has("converter.js") || paths.size !== release.files.length)
    throw Error("Invalid TM3 converter file inventory");

  const digest = await sha256(manifest);
  const root = join(site, "mod-converters", release.id);
  const destination = join(root, digest);
  for (const { path, sha256: expected } of release.files) {
    const data = new Uint8Array(await Bun.file(join(source, path)).arrayBuffer());
    if ((await sha256(data)) !== expected)
      throw Error(`TM3 converter release failed verification: ${path}`);
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, data);
  }
  await Bun.write(join(destination, "release.json"), manifest);
  await Bun.write(join(root, "pin.json"), JSON.stringify({ digest }));
}
