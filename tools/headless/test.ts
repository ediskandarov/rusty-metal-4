import { join, resolve } from "node:path";

import { root, run } from "../common.js";
await run(["bun", "tools/headless/build.ts", "--mode", "diagnostic"]);
const record = resolve(root, process.env.TM4_TEST_RECORD ?? "build/browser-record.json");
if (!(await Bun.file(record).exists()))
  throw new Error("Record the browser reference first: bun run test:simulation:record");
const child = Bun.spawn(
  [
    "cargo",
    "test",
    "--locked",
    "--manifest-path",
    join(root, "network/Cargo.toml"),
    "--target-dir",
    join(root, "build/network-native"),
    "--bin",
    "tm4-deathmatch-server",
    "simulator::tests",
    "--",
    "--include-ignored",
    "--test-threads=1",
  ],
  {
    cwd: join(root, "network"),
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      TM4_SIMULATION_WASM: join(root, "build/diagnostic/authority/site/tm4_standalone.wasm"),
      TM4_RESOURCE_DIR: resolve(root, process.env.TM4_RESOURCE_DIR ?? "build/resources"),
      TM4_TEST_RECORD: record,
    },
  },
);
if (await child.exited) throw new Error("Rust simulation checks failed");
