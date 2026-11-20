import { join } from "node:path";

import { buildManifest, loadBuildModules } from "@tm4/mr-preparation";

const sha256 = (bytes: ArrayBuffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export type BuildIdentity = {
  sha256: string;
  authoritySha256: string;
  modules: { name: string; sha256: string; authoritySha256: string }[];
};
const readModule = (site: string) => async (name: string) =>
  new Uint8Array(await Bun.file(join(site, "modules", name)).arrayBuffer());

async function calculatePlayerDigest(site: string, identity: Omit<BuildIdentity, "sha256">) {
  return new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(site, "tm4_web.wasm")).arrayBuffer())
    .update(await Bun.file(join(site, "network/tm4_network_bg.wasm")).arrayBuffer())
    .update(identity.authoritySha256)
    .update(JSON.stringify(identity.modules))
    .digest("hex");
}

export async function playerBuildDigest(site: string, identity: BuildIdentity) {
  const build = await buildManifest(JSON.stringify(identity));
  try {
    await loadBuildModules(build, "browser", readModule(site));
    return await calculatePlayerDigest(site, identity);
  } finally {
    build.free();
  }
}

export async function buildIdentity(directory: string): Promise<BuildIdentity> {
  const site = join(directory, "site");
  const authority = join(directory, "authority/site");
  const names = [...new Bun.Glob("*.wasm").scanSync({ cwd: join(site, "modules") })].sort();
  const serverNames = [
    ...new Bun.Glob("*.wasm").scanSync({ cwd: join(authority, "modules") }),
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(serverNames))
    throw new Error("Browser and authority module inventories differ");
  const modules = await Promise.all(
    names.map(async (name) => ({
      name,
      sha256: sha256(await Bun.file(join(site, "modules", name)).arrayBuffer()),
      authoritySha256: sha256(await Bun.file(join(authority, "modules", name)).arrayBuffer()),
    })),
  );
  const authoritySha256 = sha256(
    await Bun.file(join(authority, "tm4_standalone.wasm")).arrayBuffer(),
  );
  const identity = {
    authoritySha256,
    modules,
    sha256: await calculatePlayerDigest(site, { authoritySha256, modules }),
  };
  const build = await buildManifest(JSON.stringify(identity));
  try {
    await loadBuildModules(build, "browser", readModule(site));
    await loadBuildModules(build, "authority", readModule(authority));
  } finally {
    build.free();
  }
  return identity;
}
