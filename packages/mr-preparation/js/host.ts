import { readFile } from "node:fs/promises";

import init from "../build/rm4_mr_preparation.js";
import { createResourceTools } from "./prepare.ts";

export const { resourceIndex, writeResourceIndex, prepareModuleResources } = createResourceTools(
  async () =>
    init({
      module_or_path: await readFile(
        new URL("../build/rm4_mr_preparation_bg.wasm", import.meta.url),
      ),
    }),
);
