/// <reference types="bun" />
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { buildPlayer, type PlayerMode } from "../player/build.ts";

const root = resolve(import.meta.dir, "../..");

export async function buildServer(mode: PlayerMode) {
  const directory = join(root, "build", mode);
  const source = join(directory, "site");
  const output = join(directory, "server");
  const site = join(output, "site");
  const player = join(site, "play");
  await rm(site, { recursive: true, force: true });
  await mkdir(join(player, "network"), { recursive: true });
  // Only runtime artifacts enter the distribution. Never copy disc/resource directories.
  for (const name of [
    "tm4_web.js",
    "tm4_web.wasm",
    "simulation-build.json",
    "network/tm4_network.js",
    "network/tm4_network_bg.wasm",
  ]) {
    await cp(join(source, name), join(player, name));
  }
  await cp(
    join(directory, "authority/site/tm4_standalone.wasm"),
    join(output, "tm4_standalone.wasm"),
  );
  // The hosted player always uses the local folder picker, including development builds.
  await buildPlayer({ mode: "release", site: player });
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/main.ts")],
    outdir: site,
    naming: "server.js",
    target: "browser",
    minify: mode !== "diagnostic",
  });
  if (!result.success) throw new AggregateError(result.logs, "Server launcher bundle failed");
  await cp(join(import.meta.dir, "index.html"), join(site, "index.html"));
  await cp(join(import.meta.dir, "style.css"), join(site, "style.css"));
  return output;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { mode: { type: "string", default: "dev" } } });
  const mode = values.mode;
  if (mode !== "release" && mode !== "dev" && mode !== "diagnostic")
    throw new Error("Choose --mode release, dev or diagnostic");
  console.log(`Built server site: ${await buildServer(mode)}`);
}
