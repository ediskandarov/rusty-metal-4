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
    console.log("Usage: bun tools/network/build.ts [--mode dev|release|diagnostic]");
    return;
  }
  const mode = values.mode;
  if (!mode || !["dev", "release", "diagnostic"].includes(mode))
    throw new UsageError("Unknown network build mode");
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
    const toolsTarget = join(root, "build/rust-tools-target");
    await $`cargo install wasm-bindgen-cli --version 0.2.114 --locked --root ${tools} --target-dir ${toolsTarget}`.cwd(
      cwd,
    );
  }
  const features = mode === "diagnostic" ? "client,rollback_probe" : "client";
  const release = mode !== "diagnostic" ? ["--release"] : [];
  await $`cargo build --locked --lib --no-default-features --features ${features} --target wasm32-unknown-unknown --manifest-path ${manifest} --target-dir ${target} ${release}`.cwd(
    cwd,
  );
  const wasm = join(target, "wasm32-unknown-unknown", profile, "tm4_network.wasm");
  const output = join(root, "build", mode, "site/network");
  const stripNames = mode === "release" ? ["--remove-name-section"] : [];
  await $`${bindgen} ${wasm} --out-dir ${output} --target web ${stripNames}`.cwd(root);
});
