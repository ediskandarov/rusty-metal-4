import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildIdentity, playerBuildDigest } from "../../tools/build-identity.ts";

test("module bytes on either platform change compatibility and mixed browser files are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "rm4-build-"));
  const site = join(root, "site");
  try {
    for (const [path, data] of Object.entries({
      "site/tm4_web.wasm": "browser",
      "site/network/tm4_network_bg.wasm": "network",
      "site/modules/c_toy.wasm": "browser-toy",
      "authority/site/tm4_standalone.wasm": "authority",
      "authority/site/modules/c_toy.wasm": "authority-toy",
    }))
      await Bun.write(join(root, path), data);
    const first = await buildIdentity(root);
    expect(await playerBuildDigest(site, first)).toBe(first.sha256);
    await Bun.write(join(root, "authority/site/modules/c_toy.wasm"), "changed authority toy");
    const next = await buildIdentity(root);
    expect(next.sha256).not.toBe(first.sha256);
    expect(next.modules[0]!.sha256).toBe(first.modules[0]!.sha256);
    await Bun.write(join(site, "modules/c_toy.wasm"), "changed browser toy");
    await expect(playerBuildDigest(site, first)).rejects.toThrow("does not match its build");
    expect((await buildIdentity(root)).sha256).not.toBe(next.sha256);
    await Bun.write(join(site, "modules/unexpected.wasm"), "stale artifact");
    await expect(buildIdentity(root)).rejects.toThrow("inventories differ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
