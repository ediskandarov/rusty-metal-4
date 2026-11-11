import { cp, rm } from "node:fs/promises";
import { join } from "node:path";

import { $, Glob } from "bun";

import { buildPath, options, root } from "../common.js";
const { source, output: requested } = options(["source", "output"]);
const output = await buildPath(requested);
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
const patches = await Array.fromAsync(
  new Glob("*.patch").scan({ cwd: join(root, "port/psyz/patches"), dot: true }),
);
for (const name of patches.sort()) {
  const patch = join(root, "port/psyz/patches", name);
  await $`patch --batch --fuzz=0 -p1 -i ${patch}`.cwd(output);
}
