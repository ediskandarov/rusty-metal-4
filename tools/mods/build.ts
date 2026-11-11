import { mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { packCarMod, readCarMod } from "@tm4/resources/mods/package";

const [input, output] = Bun.argv.slice(2);
if (!input || !output)
  throw new Error("Usage: bun run build:mod mods/example/mod.json build/mods/example.tm4mod");
const config: unknown = await Bun.file(input).json();
if (
  !config ||
  typeof config !== "object" ||
  !("resource" in config) ||
  typeof config.resource !== "string"
)
  throw new Error("Build manifest requires a relative resource path");
const { resource, ...manifest } = config;
const root = await realpath(dirname(resolve(input)));
const path = await realpath(resolve(root, resource));
const local = relative(root, path);
if (local.startsWith("..") || local.startsWith("/"))
  throw new Error("Resource must be inside the mod directory");
const bytes = await packCarMod(manifest, new Uint8Array(await Bun.file(path).arrayBuffer()));
await mkdir(dirname(resolve(output)), { recursive: true });
await Bun.write(output, bytes);
console.log(`Built ${output}: ${bytes.length} bytes; no disc files or game build needed.`);
for (const warning of (await readCarMod(bytes)).warnings) console.log(`WARNING: ${warning}`);
