import { join } from "node:path";

import { root, run } from "../common.js";

const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex < 0 ? "dev" : process.argv[modeIndex + 1];
if (!mode || !["dev", "release", "diagnostic"].includes(mode))
  throw new Error("Unknown network build mode");
const profile = mode !== "diagnostic" ? "release" : "debug";
const manifest = join(root, "network/Cargo.toml");
const target = join(root, "build/network-wasm");
const tools = join(root, "build/rust-tools");
const bindgen = join(
  tools,
  "bin",
  process.platform === "win32" ? "wasm-bindgen.exe" : "wasm-bindgen",
);
const cwd = join(root, "network");
if (!(await Bun.file(bindgen).exists())) {
  await run(
    [
      "cargo",
      "install",
      "wasm-bindgen-cli",
      "--version",
      "0.2.114",
      "--locked",
      "--root",
      tools,
      "--target-dir",
      join(root, "build/rust-tools-target"),
    ],
    { cwd },
  );
}
await run(
  [
    "cargo",
    "build",
    "--locked",
    "--lib",
    "--no-default-features",
    "--features",
    mode === "diagnostic" ? "client,rollback_probe" : "client",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    manifest,
    "--target-dir",
    target,
    ...(mode !== "diagnostic" ? ["--release"] : []),
  ],
  { cwd },
);
await run([
  bindgen,
  join(target, "wasm32-unknown-unknown", profile, "tm4_network.wasm"),
  "--out-dir",
  join(root, "build", mode, "site/network"),
  "--target",
  "web",
  ...(mode === "release" ? ["--remove-name-section"] : []),
]);
