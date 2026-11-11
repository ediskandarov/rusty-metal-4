import { appendFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";

import { root, run } from "../common.js";

const environment = process.env.GITHUB_ENV;
if (!environment) throw new Error("This setup runs inside GitHub Actions");
const { toolchain } = Bun.TOML.parse(
  await Bun.file(join(root, "network/rust-toolchain.toml")).text(),
) as { toolchain: { channel: string; profile: string; targets: string[] } };
await run([
  "rustup",
  "toolchain",
  "install",
  toolchain.channel,
  "--no-self-update",
  "--profile",
  toolchain.profile,
  "--target",
  toolchain.targets.join(","),
]);
// Leave room for the linker and memory-heavy Cranelift compilation.
const gib = 1024 ** 3;
const jobs = Math.max(
  1,
  Math.min(availableParallelism(), Math.floor((totalmem() - gib) / (3 * gib))),
);
await appendFile(
  environment,
  `RUSTUP_TOOLCHAIN=${toolchain.channel}\nCARGO_BUILD_JOBS=${jobs}\nCARGO_INCREMENTAL=0\n`,
);
console.log(
  `Rust ${toolchain.channel}: ${jobs} build jobs on ${Math.round(totalmem() / gib)} GiB RAM`,
);
