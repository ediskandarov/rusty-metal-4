import { cp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { buildPath, options, root, run } from "../common.js";
const { source, output: requested } = options(["source", "output"]);
const output = await buildPath(requested);
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
for (const name of (await readdir(join(root, "port/psyz/patches")))
  .filter((n) => n.endsWith(".patch"))
  .sort()) {
  await run(["patch", "--batch", "--fuzz=0", "-p1", "-i", join(root, "port/psyz/patches", name)], {
    cwd: output,
  });
}
