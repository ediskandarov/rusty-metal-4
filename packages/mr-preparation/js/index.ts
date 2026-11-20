/// <reference types="vite/client" />
import init from "../build/rm4_mr_preparation.js";
import wasmUrl from "../build/rm4_mr_preparation_bg.wasm?url";
import { createResourceTools } from "./prepare.ts";

export const { resourceIndex, writeResourceIndex, prepareModuleResources } = createResourceTools(
  () => init({ module_or_path: wasmUrl }),
);
