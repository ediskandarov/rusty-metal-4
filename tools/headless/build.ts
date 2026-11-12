import { join } from "node:path";

import { $ } from "bun";

import { runCli } from "../cli.js";
import { root } from "../common.js";
await runCli(async () => {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex < 0 ? "dev" : process.argv[modeIndex + 1];
  if (!mode || !["dev", "release", "diagnostic"].includes(mode))
    throw new Error("Unknown simulation build mode");
  const directory = join(root, "build", mode, "authority");
  const definitions = [
    "-DCMAKE_BUILD_TYPE=Release",
    "-DTM4_STANDALONE=ON",
    `-DTM4_WEB_TEST_HOOKS=${mode === "diagnostic" ? "ON" : "OFF"}`,
  ];
  await $`emcmake cmake -S ${root} -B ${directory} ${definitions}`.cwd(root);
  await $`cmake --build ${directory} --target tm4_web --parallel 4`.cwd(root);
});
