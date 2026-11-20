import { join } from "node:path";

import { prepareModuleResources } from "@tm4/mr-preparation";

export async function prepareRuntimeFiles(resources, site) {
  const files = new Map();
  for (const path of new Bun.Glob("DATA/**/*").scanSync({ cwd: resources }))
    if (/\.(MR|IMG|VAB|TIM|tsv)$/i.test(path))
      files.set("/" + path, new Uint8Array(await Bun.file(join(resources, path)).arrayBuffer()));
  const modules = new Map();
  for (const path of new Bun.Glob("*.wasm").scanSync({ cwd: join(site, "modules") }))
    modules.set(
      path.replace(/\.wasm$/, ".sym"),
      new Uint8Array(await Bun.file(join(site, "modules", path)).arrayBuffer()),
    );
  await prepareModuleResources(files, modules);
  return files;
}
