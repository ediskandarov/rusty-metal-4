import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { buildPlayer } from "../apps/player/build.ts";
import { buildServer } from "../apps/server/build.ts";
import { runCli, UsageError } from "./cli.js";
import { root } from "./common.js";
await runCli(async () => {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      dev: { type: "boolean", default: false },
      diagnostic: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: bun run build [--dev | --diagnostic]");
    return;
  }
  if (values.dev && values.diagnostic) throw new UsageError("Choose either --dev or --diagnostic");
  const mode = values.diagnostic ? "diagnostic" : values.dev ? "dev" : "release";
  const diagnostics = values.diagnostic;
  const directory = join(root, "build", mode);
  const site = join(directory, "site");
  await mkdir(site, { recursive: true });
  await $`bun run typecheck`.cwd(root);
  const definitions = [
    `-DCMAKE_BUILD_TYPE=${diagnostics ? "Debug" : "Release"}`,
    `-DTM4_WEB_TEST_HOOKS=${diagnostics ? "ON" : "OFF"}`,
  ];
  await $`emcmake cmake -S ${root} -B ${directory} ${definitions}`.cwd(root);
  await $`cmake --build ${directory} --parallel ${Math.min(8, navigator.hardwareConcurrency)}`.cwd(
    root,
  );
  await buildPlayer({ mode, site });
  console.log(`Built ${mode}: ${site}`);

  await $`bun tools/network/build.ts --mode ${mode}`.cwd(root);
  await $`bun tools/headless/build.ts --mode ${mode}`.cwd(root);
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
});
