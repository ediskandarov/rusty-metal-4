import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { $ } from "bun";

import { root } from "../common.js";

// Git's common directory belongs to the repository, not to a disposable worktree.
const git = await $`git rev-parse --path-format=absolute --git-common-dir`
  .cwd(root)
  .quiet()
  .nothrow();
if (git.exitCode === 0) {
  const shared = join(git.stdout.toString().trim(), "rm4-cache", "cargo");
  const local = join(root, "build/cargo-cache");
  await mkdir(shared, { recursive: true });
  await mkdir(join(root, "build"), { recursive: true });
  const existing = await lstat(local).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!existing) await symlink(shared, local, process.platform === "win32" ? "junction" : "dir");
  else if ((await realpath(local)) !== (await realpath(shared)))
    throw new Error(`Refusing to replace an existing cache at ${local}; move it aside first.`);
  console.log(`Shared Cargo cache: ${shared}`);
}
