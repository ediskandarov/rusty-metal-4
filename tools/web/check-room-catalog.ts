import assert from "node:assert/strict";

import { maps } from "@tm4/rooms-client/schemas";

import { readMr } from "../../packages/resources/src/compatibility/mr.ts";

const path = process.argv[2];
if (!path) throw new Error("Usage: bun tools/web/check-room-catalog.ts /path/to/DATA/MAIN.MR");
const registry = await readMr(new Uint8Array(await Bun.file(path).arrayBuffer()));
const worlds = registry.directories.get("Root/worlds");
assert(worlds, "MAIN.MR must contain Root/worlds");
assert.deepEqual(
  maps.map((map) => map.label),
  [...worlds.folders.keys()],
);
console.log(`PASS ${maps.length} room maps match MAIN.MR world metadata`);
