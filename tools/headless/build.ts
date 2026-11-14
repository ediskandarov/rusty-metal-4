import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { runCli, UsageError } from "../cli.js";
import { root } from "../common.js";
await runCli(async () => {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: { help: { type: "boolean", short: "h" }, mode: { type: "string", default: "dev" } },
  });
  if (values.help) {
    console.log("Usage: bun tools/headless/build.ts [--mode dev|release|diagnostic]");
    return;
  }
  const mode = values.mode;
  if (!mode || !["dev", "release", "diagnostic"].includes(mode))
    throw new UsageError("Unknown simulation build mode");
  const directory = join(root, "build", mode, "authority");
  const definitions = [
    "-DCMAKE_BUILD_TYPE=Release",
    "-DTM4_STANDALONE=ON",
    `-DTM4_WEB_TEST_HOOKS=${mode === "diagnostic" ? "ON" : "OFF"}`,
  ];
  await $`emcmake cmake -S ${root} -B ${directory} ${definitions}`.cwd(root);
  await $`cmake --build ${directory} --target tm4_web --parallel 4`.cwd(root);
});
