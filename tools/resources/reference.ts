import { parseArgs } from "node:util";

import { generateResourceReference } from "@tm4/resources/host/resources";

import discReference from "../../config/disc.json";
import { runCli, UsageError } from "../cli.js";

await runCli(async () => {
  const { values, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log("Usage: bun tools/resources/reference.ts DISC_DIRECTORY");
    return;
  }
  const [directory] = positionals;
  if (positionals.length !== 1 || !directory)
    throw new UsageError("bun tools/resources/reference.ts DISC_DIRECTORY");

  const reference = await generateResourceReference(directory, discReference);
  await Bun.write(
    new URL("../../config/resources.json", import.meta.url),
    JSON.stringify(reference, null, 2) + "\n",
  );
  console.log(
    `Recorded ${reference.files.length} resource checksums; no disc content or source paths stored.`,
  );
});
