import { readFile } from "node:fs/promises";

import { createResourceTools } from "./prepare.ts";

export const {
  buildManifest,
  getBuildManifest,
  loadBuildModules,
  resourceIndex,
  writeResourceIndex,
  prepareModuleResources,
} = createResourceTools(async () => {
  const runtime = await import("../build/rm4_mr_preparation.js");
  await runtime.default({
    module_or_path: await readFile(new URL("../build/rm4_mr_preparation_bg.wasm", import.meta.url)),
  });
  return runtime;
});
