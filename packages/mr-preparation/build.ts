import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { wasmBindgen } from "../../tools/rust/wasm-bindgen.ts";

export async function buildPreparation() {
  const directory = import.meta.dir;
  const root = resolve(directory, "../..");
  const manifest = join(directory, "Cargo.toml");
  const target = join(root, "build/mr-preparation");
  const cargo = Bun.TOML.parse(await Bun.file(manifest).text()) as {
    dependencies: { "wasm-bindgen": { version: string } };
  };
  const bindgen = await wasmBindgen(cargo.dependencies["wasm-bindgen"].version);
  await $`cargo build --locked --release --lib --features web --target wasm32-unknown-unknown --manifest-path ${manifest} --target-dir ${target}`.cwd(
    join(root, "network"),
  );
  await $`${bindgen} ${join(target, "wasm32-unknown-unknown/release/rm4_mr_preparation.wasm")} --target web --out-dir ${join(directory, "build")} --remove-name-section`.cwd(
    root,
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { test: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: false,
  });
  await buildPreparation();
  if (values.test) {
    const root = resolve(import.meta.dir, "../..");
    await $`cargo test --locked --manifest-path ${join(import.meta.dir, "Cargo.toml")} --target-dir ${join(root, "build/mr-preparation")}`.cwd(
      join(root, "network"),
    );
  }
}
