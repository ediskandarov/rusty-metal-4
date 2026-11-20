/// <reference types="vite/client" />
import wasmUrl from "../build/rm4_mr_preparation_bg.wasm?url";
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
  await runtime.default({ module_or_path: wasmUrl });
  return runtime;
});
