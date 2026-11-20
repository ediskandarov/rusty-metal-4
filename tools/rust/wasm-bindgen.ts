import { join } from "node:path";

import { $ } from "bun";

import { root } from "../common.js";

export async function wasmBindgen(requirement: string): Promise<string> {
  const tools = join(root, "build/rust-tools");
  const bindgen = join(
    tools,
    "bin",
    process.platform === "win32" ? "wasm-bindgen.exe" : "wasm-bindgen",
  );
  if (typeof requirement !== "string" || !/^=\d+\.\d+\.\d+$/.test(requirement))
    throw new Error("Pin wasm-bindgen to an exact release in Cargo.toml (for example =0.2.114)");
  const bindgenVersion = requirement.slice(1);
  const hasExpectedVersion = async () => {
    if (!(await Bun.file(bindgen).exists())) return false;
    const result = await $`${bindgen} --version`.quiet().nothrow();
    return (
      result.exitCode === 0 && result.stdout.toString().trim() === `wasm-bindgen ${bindgenVersion}`
    );
  };
  if (!(await hasExpectedVersion())) {
    const toolsTarget = join(root, "build/rust-tools-target");
    await $`cargo install wasm-bindgen-cli --version ${requirement} --locked --force --root ${tools} --target-dir ${toolsTarget}`.cwd(
      join(root, "network"),
    );
    if (!(await hasExpectedVersion()))
      throw new Error(
        `Installed wasm-bindgen-cli does not report expected version ${bindgenVersion}`,
      );
  }

  return bindgen;
}
