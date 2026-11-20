/// <reference types="vite/client" />
import init from "../build/rm4_mr_preparation.js";
import wasmUrl from "../build/rm4_mr_preparation_bg.wasm?url";
import { createPreparer } from "./prepare.ts";

export const prepareModuleResources = createPreparer(() => init({ module_or_path: wasmUrl }));
