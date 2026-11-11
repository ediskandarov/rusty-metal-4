import { generateResourceReference } from "@tm4/resources/host/resources";

import discReference from "../../config/disc.json";

const directory = process.argv[2];
if (!directory)
  throw new Error("Usage: bun tools/resources/reference.ts <original-disc-directory>");
const reference = await generateResourceReference(directory, discReference);
await Bun.write(
  new URL("../../config/resources.json", import.meta.url),
  JSON.stringify(reference, null, 2) + "\n",
);
console.log(
  `Recorded ${reference.files.length} resource checksums; no disc content or source paths stored.`,
);
