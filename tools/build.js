import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { buildPlayer } from "../apps/player/build.ts";
import { buildServer } from "../apps/server/build.ts";
import { root, run } from "./common.js";
const { values } = parseArgs({
  options: {
    dev: { type: "boolean", default: false },
    diagnostic: { type: "boolean", default: false },
  },
});
if (values.dev && values.diagnostic) throw new Error("Choose either --dev or --diagnostic");
const mode = values.diagnostic ? "diagnostic" : values.dev ? "dev" : "release";
const diagnostics = values.diagnostic;
const directory = join(root, "build", mode);
const site = join(directory, "site");
await mkdir(site, { recursive: true });
await run(["bun", "run", "typecheck"]);
await run([
  "emcmake",
  "cmake",
  "-S",
  root,
  "-B",
  directory,
  `-DCMAKE_BUILD_TYPE=${diagnostics ? "Debug" : "Release"}`,
  `-DTM4_WEB_TEST_HOOKS=${diagnostics ? "ON" : "OFF"}`,
]);
await run([
  "cmake",
  "--build",
  directory,
  "--parallel",
  String(Math.min(8, navigator.hardwareConcurrency)),
]);
await buildPlayer({ mode, site });
console.log(`Built ${mode}: ${site}`);

await run(["bun", "tools/network/build.ts", "--mode", mode]);
await run(["bun", "tools/headless/build.ts", "--mode", mode]);
const authority = await Bun.file(
  join(directory, "authority/site/tm4_standalone.wasm"),
).arrayBuffer();
const wasm = await Bun.file(join(site, "tm4_web.wasm")).arrayBuffer();
await Bun.write(
  join(site, "simulation-build.json"),
  JSON.stringify({
    authoritySha256: new Bun.CryptoHasher("sha256").update(authority).digest("hex"),
    sha256: new Bun.CryptoHasher("sha256")
      .update(wasm)
      .update(await Bun.file(join(site, "network/tm4_network_bg.wasm")).arrayBuffer())
      .digest("hex"),
  }),
);
await buildServer(mode);
