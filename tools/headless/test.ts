import { join, resolve } from "node:path";

import { $ } from "bun";

import { root } from "../common.js";
await $`bun tools/headless/build.ts --mode diagnostic`.cwd(root);
const record = resolve(root, process.env.TM4_TEST_RECORD ?? "build/browser-record.json");
if (!(await Bun.file(record).exists()))
  throw new Error("Record the browser reference first: bun run test:simulation:record");
const manifest = join(root, "network/Cargo.toml");
const target = join(root, "build/network-native");
await $`cargo test --locked --manifest-path ${manifest} --target-dir ${target} --bin tm4-deathmatch-server simulator::tests -- --include-ignored --test-threads=1`
  .cwd(join(root, "network"))
  .env({
    ...process.env,
    TM4_SIMULATION_WASM: join(root, "build/diagnostic/authority/site/tm4_standalone.wasm"),
    TM4_RESOURCE_DIR: resolve(root, process.env.TM4_RESOURCE_DIR ?? "build/resources"),
    TM4_TEST_RECORD: record,
  });
