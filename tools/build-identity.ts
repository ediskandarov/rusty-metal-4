import { join } from "node:path";

const sha256 = (bytes: ArrayBuffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export async function playerBuildDigest(
  site: string,
  identity: {
    authoritySha256: string;
    modules: { name: string; sha256: string; authoritySha256: string }[];
  },
) {
  for (const entry of identity.modules) {
    if (sha256(await Bun.file(join(site, "modules", entry.name)).arrayBuffer()) !== entry.sha256)
      throw new Error("Resource module does not match its build: " + entry.name);
  }
  return new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(site, "tm4_web.wasm")).arrayBuffer())
    .update(await Bun.file(join(site, "network/tm4_network_bg.wasm")).arrayBuffer())
    .update(identity.authoritySha256)
    .update(JSON.stringify(identity.modules))
    .digest("hex");
}

export async function buildIdentity(directory: string) {
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
  if (!names.length) throw new Error("No resource modules in build");
  return {
    authoritySha256,
    modules,
    sha256: await playerBuildDigest(site, { authoritySha256, modules }),
  };
}
