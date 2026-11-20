import { readFile } from "node:fs/promises";

import init from "../build/rm4_mr_preparation.js";
import { createPreparer } from "./prepare.ts";

export const prepareModuleResources = createPreparer(async () =>
  init({
    module_or_path: await readFile(new URL("../build/rm4_mr_preparation_bg.wasm", import.meta.url)),
  }),
);
