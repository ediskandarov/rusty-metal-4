import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { $, Glob } from "bun";

import { runCli } from "../cli.js";
import { buildPath, options, root } from "../common.js";
await runCli(async () => {
  const { output: requested } = options(["output"]);
  const output = await buildPath(requested);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const archive = `${output}.tar`;
  try {
    await $`git -C ${join(root, "game")} archive -o ${archive} HEAD src include config`.cwd(root);
    await $`tar -xf ${archive} -C ${output}`.cwd(root);
    const patches = await Array.fromAsync(
      new Glob("*.patch").scan({ cwd: join(root, "patches/game"), dot: true }),
    );
    for (const name of patches.sort()) {
      const patch = join(root, "patches/game", name);
      await $`patch --batch --fuzz=0 -E -p1 -i ${patch}`.cwd(output);
    }
  } finally {
    await rm(archive, { force: true });
  }
});
