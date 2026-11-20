import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildManifest } from "@tm4/mr-preparation";

import { nameModule } from "../../packages/resources/src/mods/modules.ts";

const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const wasm = (variant: number) =>
  nameModule(new Uint8Array([...empty, 0, 2, 0, variant]), "c_toy.sym");

import { buildIdentity, playerBuildDigest } from "../../tools/build-identity.ts";

test("module bytes on either platform change compatibility and mixed browser files are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "rm4-build-"));
  const site = join(root, "site");
  try {
    for (const [path, data] of Object.entries({
      "site/tm4_web.wasm": "browser",
      "site/network/tm4_network_bg.wasm": "network",
      "site/modules/c_toy.wasm": wasm(1),
      "authority/site/tm4_standalone.wasm": "authority",
      "authority/site/modules/c_toy.wasm": wasm(2),
    }))
      await Bun.write(join(root, path), data);
    const first = await buildIdentity(root);
    const parsed = await buildManifest(JSON.stringify(first));
    try {
      expect(parsed.sha256).toBe(first.sha256);
    } finally {
      parsed.free();
    }
    expect(await playerBuildDigest(site, first)).toBe(first.sha256);
    await Bun.write(join(root, "authority/site/modules/c_toy.wasm"), wasm(3));
    const next = await buildIdentity(root);
    expect(next.sha256).not.toBe(first.sha256);
    expect(next.modules[0]!.sha256).toBe(first.modules[0]!.sha256);
    await Bun.write(join(site, "modules/c_toy.wasm"), wasm(4));
    await expect(playerBuildDigest(site, first)).rejects.toThrow("different build");
    expect((await buildIdentity(root)).sha256).not.toBe(next.sha256);
    await Bun.write(join(site, "modules/unexpected.wasm"), "stale artifact");
    await expect(buildIdentity(root)).rejects.toThrow("inventories differ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
