import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { prepareResources } from "@tm4/resources/host/resources";

import { runCli, UsageError } from "../cli.js";

await runCli(async () => {
  const { values, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log("Usage: bun tools/headless/prepare-resources.ts DISC_DIRECTORY OUTPUT_DIRECTORY");
    return;
  }
  const [discDirectory, destination] = positionals;
  if (positionals.length !== 2 || !discDirectory || !destination)
    throw new UsageError("bun tools/headless/prepare-resources.ts DISC_DIRECTORY OUTPUT_DIRECTORY");

  const count = await prepareResources(discDirectory, destination);
  console.log(`Prepared ${count} private local resources in ${resolve(destination)}`);
});
