import { resolve } from "node:path";

import { prepareResources } from "@tm4/resources/host/resources";

const [discDirectory, destination] = process.argv.slice(2);
if (!discDirectory || !destination)
  throw new Error(
    "Usage: bun tools/headless/prepare-resources.ts <local-disc-directory> <output-directory>",
  );
const count = await prepareResources(discDirectory, destination);
console.log(`Prepared ${count} private local resources in ${resolve(destination)}`);
