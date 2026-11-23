import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256 } from "@tm4/mods";
import { tm3ConverterPath } from "@tm4/mods/converter-paths";
import { readConverterRelease } from "@tm4/mods/recipe";

export async function verifyConverter(source: string) {
  const manifest = new Uint8Array(await Bun.file(join(source, "release.json")).arrayBuffer());
  const release = await readConverterRelease(manifest);
  const digest = await sha256(manifest);
  for (const { path, sha256: expected } of release.files) {
    const data = new Uint8Array(await Bun.file(join(source, path)).arrayBuffer());
    if ((await sha256(data)) !== expected)
      throw Error(`TM3 converter release failed verification: ${path}`);
  }
  return { digest, release };
}

export async function stageConverter(source: string, site: string, runtime: string) {
  const { digest, release } = await verifyConverter(source);
  if (release.runtime !== runtime)
    throw Error("The TM3 converter targets a different player runtime");
  const root = join(site, tm3ConverterPath);
  const destination = join(root, digest);
  for (const path of [...release.files.map((file) => file.path), "release.json"]) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, path), target);
  }
  await Bun.write(join(root, "pin.json"), JSON.stringify({ digest }));
}
