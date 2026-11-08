import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { root, run } from "./common.js";
const { values } = parseArgs({ options: { dev: { type: "boolean", default: false } } });
const mode = values.dev ? "dev" : "release";
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
  `-DCMAKE_BUILD_TYPE=${values.dev ? "Debug" : "Release"}`,
  `-DTM4_WEB_TEST_HOOKS=${values.dev ? "ON" : "OFF"}`,
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
  minify: !values.dev,
  sourcemap: values.dev ? "linked" : "none",
  define: { TM4_DEV: JSON.stringify(values.dev) },
});
if (!result.success) throw new AggregateError(result.logs, "Browser bundle failed");
await cp(join(root, "web/index.html"), join(site, "index.html"));
await cp(join(root, "web/styles"), join(site, "styles"), { recursive: true });
console.log(`Built ${mode}: ${site}`);
