/// <reference types="bun" />
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { type BuildIdentity, playerBuildDigest } from "../../tools/build-identity.ts";
import { buildSite } from "../../tools/web/build.ts";
import { buildPlayer } from "../player/build.ts";
import { installConverter } from "./mod-converter.ts";

const root = resolve(import.meta.dir, "../..");
const site = join(root, "build/release/rustymetal4.com-site");
await rm(site, { recursive: true, force: true });
await buildSite("rustymetal4.com", "release", site);

const converter = process.env.TM4_TM3_CONVERTER;
const runtime = process.env.TM4_PLAYER_RUNTIME ?? join(root, "build/release/site");
if (await Bun.file(join(runtime, "simulation-build.json")).exists()) {
  // playerBuildDigest validates the complete manifest through Rust before using it.
  const manifest = (await Bun.file(join(runtime, "simulation-build.json")).json()) as BuildIdentity;
  const digest = await playerBuildDigest(runtime, manifest);
  if (digest !== manifest.sha256)
    throw new Error("Player runtime does not match its compatibility manifest");
  const player = join(site, "play");
  await mkdir(join(player, "network"), { recursive: true });
  for (const name of [
    "tm4_web.js",
    "tm4_web.wasm",
    "simulation-build.json",
    "network/tm4_network.js",
    "network/tm4_network_bg.wasm",
  ])
    await cp(join(runtime, name), join(player, name));
  await cp(join(runtime, "modules"), join(player, "modules"), { recursive: true });
  await buildPlayer({ mode: "release", site: player, modLibrary: true });
  if (converter) await installConverter(converter, site, digest);
} else {
  if (converter) throw Error("A player runtime is required to ship a TM3 converter");
  console.log(
    "Room-only build: set TM4_PLAYER_RUNTIME to an existing runtime site to enable matches.",
  );
}
