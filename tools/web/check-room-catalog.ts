import assert from "node:assert/strict";
import { parseArgs } from "node:util";

import { maps } from "@tm4/rooms-client/schemas";

import { readMr } from "../../packages/resources/src/compatibility/mr.ts";
import { runCli, UsageError } from "../cli.js";

await runCli(async () => {
  const { values, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log("Usage: bun tools/web/check-room-catalog.ts MAIN.MR");
    return;
  }
  const [path] = positionals;
  if (positionals.length !== 1 || !path)
    throw new UsageError("bun tools/web/check-room-catalog.ts MAIN.MR");

  const registry = await readMr(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const worlds = registry.directories.get("Root/worlds");
  assert(worlds, "MAIN.MR must contain Root/worlds");
  assert.deepEqual(
    maps.map((map) => map.label),
    [...worlds.folders.keys()],
  );
  console.log(`PASS ${maps.length} room maps match MAIN.MR world metadata`);
});
