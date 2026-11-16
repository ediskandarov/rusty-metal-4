import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { runCli, UsageError } from "../cli.js";
import { buildPath, root } from "../common.js";

await runCli(async () => {
  const { values } = parseArgs({ options: { output: { type: "string" } }, strict: true });
  if (!values.output) throw new UsageError("Supply --output");
  const output = await buildPath(values.output);
  const upstream = join(root, "external/psyz");
  await mkdir(output, { recursive: true });
  await cp(join(upstream, "psyz/CMakeLists.txt"), join(output, "CMakeLists.txt"));
  await cp(join(upstream, "psyz/cmake"), join(output, "cmake"), { recursive: true });
  await $`patch --batch --fuzz=0 -p1 -i ${join(root, "port/psyz/headless-cmake.patch")}`.cwd(
    output,
  );
  const cmake = Bun.file(join(output, "CMakeLists.txt"));
  await Bun.write(
    cmake,
    (await cmake.text())
      .replaceAll("../decomp/", `${upstream}/decomp/`)
      .replaceAll("${CMAKE_CURRENT_SOURCE_DIR}/../external/", `${upstream}/external/`),
  );
  try {
    await symlink(join(upstream, "psyz/include"), join(output, "include"));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await $`bun ${join(root, "tools/prepare/psyz.js")} --source ${join(upstream, "psyz/src")} --output ${join(output, "src")}`;
});
