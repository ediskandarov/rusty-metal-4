import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { buildPath, options, root, run } from "../common.js";
const { output: requested } = options(["output"]);
const output = await buildPath(requested);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const archive = `${output}.tar`;
try {
  await run([
    "git",
    "-C",
    join(root, "game"),
    "archive",
    "-o",
    archive,
    "HEAD",
    "src",
    "include",
    "config",
  ]);
  await run(["tar", "-xf", archive, "-C", output]);
  for (const name of (await readdir(join(root, "patches/game")))
    .filter((n) => n.endsWith(".patch"))
    .sort()) {
    await run(
      ["patch", "--batch", "--fuzz=0", "-E", "-p1", "-i", join(root, "patches/game", name)],
      { cwd: output },
    );
  }
} finally {
  await rm(archive, { force: true });
}
