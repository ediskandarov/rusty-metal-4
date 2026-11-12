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
  const site = join(directory, "server-site");
  const player = join(site, "play");
  await rm(site, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const manifest: unknown = await Bun.file(join(source, "simulation-build.json")).json();
  const simulation = await Bun.file(
    join(directory, "authority/site/tm4_standalone.wasm"),
  ).arrayBuffer();
  const authorityHash = new Bun.CryptoHasher("sha256").update(simulation).digest("hex");
  const browserHash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(source, "tm4_web.wasm")).arrayBuffer())
    .update(await Bun.file(join(source, "network/tm4_network_bg.wasm")).arrayBuffer())
    .digest("hex");
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("authoritySha256" in manifest) ||
    manifest.authoritySha256 !== authorityHash ||
    !("sha256" in manifest) ||
    manifest.sha256 !== browserHash
  )
    throw new Error("Server/client build manifest is stale");
  await cp(join(source, "simulation-build.json"), join(output, "simulation-build.json"));
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
  await mkdir(join(site, "licenses"), { recursive: true });
  for (const [name, path] of [
    ["rustymetal4", "LICENSE"],
    ["psyz", "external/psyz/LICENSE"],
    ["sdl", "external/psyz/external/SDL/LICENSE.txt"],
  ] as const)
    await cp(join(root, path), join(site, "licenses", `${name}.txt`));
  return output;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { mode: { type: "string", default: "dev" } } });
  const mode = values.mode;
  if (mode !== "release" && mode !== "dev" && mode !== "diagnostic")
    throw new Error("Choose --mode release, dev or diagnostic");
  console.log(`Built server bundle: ${await buildServer(mode)}`);
}
