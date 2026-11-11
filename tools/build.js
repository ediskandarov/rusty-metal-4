import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

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
const localDisc = values.dev || diagnostics;
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
const result = await Bun.build({
  entrypoints: [join(root, "web/src/main.ts")],
  outdir: site,
  naming: "web.js",
  target: "browser",
  minify: !diagnostics,
  sourcemap: diagnostics ? "linked" : "none",
  define: { TM4_DEV: JSON.stringify(localDisc) },
});
if (!result.success) throw new AggregateError(result.logs, "Browser bundle failed");
if (!diagnostics) await rm(join(site, "web.js.map"), { force: true });
if (diagnostics) {
  const probe = await Bun.build({
    entrypoints: [join(root, "web/src/network/rollbackProbe.ts")],
    outdir: site,
    naming: "rollback-probe.js",
    target: "browser",
  });
  if (!probe.success) throw new AggregateError(probe.logs, "Rollback probe bundle failed");
}
await cp(
  join(root, "node_modules/coi-serviceworker/coi-serviceworker.min.js"),
  join(site, "coi-serviceworker.js"),
);
await cp(
  join(root, "node_modules/coi-serviceworker/LICENSE"),
  join(site, "coi-serviceworker.LICENSE.txt"),
);
await cp(join(root, "web/index.html"), join(site, "index.html"));
await cp(join(root, "web/styles"), join(site, "styles"), { recursive: true });
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
