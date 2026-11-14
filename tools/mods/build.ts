import { mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { packCarMod, readCarMod } from "@tm4/resources/mods/package";

import { runCli, UsageError } from "../cli.js";

await runCli(async () => {
  const { values, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log("Usage: bun run build:mod INPUT OUTPUT");
    return;
  }
  const [input, output] = positionals;
  if (positionals.length !== 2 || !input || !output)
    throw new UsageError("bun run build:mod INPUT OUTPUT");

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
});
