import { join } from "node:path";

import { root, run } from "../common.js";
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex < 0 ? "dev" : process.argv[modeIndex + 1];
if (!mode || !["dev", "release", "diagnostic"].includes(mode))
  throw new Error("Unknown simulation build mode");
const directory = join(root, "build", mode, "authority");
await run([
  "emcmake",
  "cmake",
  "-S",
  root,
  "-B",
  directory,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DTM4_STANDALONE=ON",
  `-DTM4_WEB_TEST_HOOKS=${mode === "diagnostic" ? "ON" : "OFF"}`,
]);
await run(["cmake", "--build", directory, "--target", "tm4_web", "--parallel", "4"]);
