/// <reference types="bun" />
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildSite } from "../../tools/web/build.ts";
import { buildPlayer } from "../player/build.ts";

const root = resolve(import.meta.dir, "../..");
const site = join(root, "build/release/rustymetal4.com-site");
await rm(site, { recursive: true, force: true });
await buildSite("rustymetal4.com", "release", site);

const runtime = process.env.TM4_PLAYER_RUNTIME ?? join(root, "build/release/site");
if (await Bun.file(join(runtime, "simulation-build.json")).exists()) {
  const manifest = (await Bun.file(join(runtime, "simulation-build.json")).json()) as {
    sha256: string;
  };
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(runtime, "tm4_web.wasm")).arrayBuffer())
    .update(await Bun.file(join(runtime, "network/tm4_network_bg.wasm")).arrayBuffer())
    .digest("hex");
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
  await buildPlayer({ mode: "release", site: player });
} else
  console.log(
    "Room-only build: set TM4_PLAYER_RUNTIME to an existing runtime site to enable matches.",
  );
