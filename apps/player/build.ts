/// <reference types="bun" />

import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type PlayerMode = "release" | "dev" | "diagnostic";
const root = resolve(import.meta.dir, "../..");
const app = import.meta.dir;

// Bundle the player independently of the CMake and Cargo runtime builds.
export async function buildPlayer({ mode, site }: { mode: PlayerMode; site: string }) {
  const diagnostic = mode === "diagnostic";
  await mkdir(site, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(app, "src/main.ts")],
    outdir: site,
    naming: "web.js",
    target: "browser",
    minify: !diagnostic,
    sourcemap: diagnostic ? "linked" : "none",
    define: { TM4_DEV: JSON.stringify(mode !== "release") },
  });
  if (!result.success) throw new AggregateError(result.logs, "Browser bundle failed");
  if (!diagnostic) await rm(join(site, "web.js.map"), { force: true });
  if (diagnostic) {
    const probe = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve("@tm4/game-client/network/rollbackProbe"))],
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
  const fxaaSource = await Bun.file(join(root, "external/fxaa/fxaa.glsl")).text();
  const fxaaNotice =
    fxaaSource.startsWith("/**") && fxaaSource.includes("*/")
      ? fxaaSource.slice(3, fxaaSource.indexOf("*/")).trim()
      : null;
  if (!fxaaNotice) throw new Error("Missing FXAA source copyright notice");
  const fxaaLicense = await Bun.file(join(root, "external/fxaa/LICENSE.md")).text();
  const smaaLicense = await Bun.file(join(root, "external/smaa/LICENSE.txt")).text();
  await Bun.write(
    join(site, "antialiasing.LICENSE.txt"),
    [
      "FXAA: https://github.com/mattdesl/glsl-fxaa",
      fxaaNotice,
      fxaaLicense,
      "SMAA: https://github.com/iryoku/smaa",
      smaaLicense,
    ].join("\n\n"),
  );
  await cp(join(app, "index.html"), join(site, "index.html"));
  await cp(join(app, "styles"), join(site, "styles"), { recursive: true });
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { mode: { type: "string", default: "release" } } });
  const mode = values.mode;
  if (mode !== "release" && mode !== "dev" && mode !== "diagnostic")
    throw new Error("Choose --mode release, dev or diagnostic");
  const site = join(root, "build", mode, "site");
  await buildPlayer({ mode, site });
  console.log(`Built player (${mode}): ${site}`);
}
