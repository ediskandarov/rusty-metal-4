import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { root } from "../common.js";

const { values } = parseArgs({
  options: { mode: { type: "string", default: "release" } },
});
const mode = values.mode;
if (mode !== "release" && mode !== "dev") throw new Error("Choose --mode release or dev");
const platforms: Record<string, string> = {
  "linux-x64": "linux-x64",
  "win32-x64": "windows-x64",
  "darwin-arm64": "macos-arm64",
};
const platform = platforms[`${process.platform}-${process.arch}`];
if (!platform) throw new Error("Unsupported server release platform");
const bundle = join(root, "build", mode, "server");
if (!(await Bun.file(join(bundle, "site/play/simulation-build.json")).exists()))
  throw new Error(`Build the matching server bundle first: ${bundle}`);
const target = join(root, "build/network-native");
await $`cargo build --locked --release --bin tm4-deathmatch-server --features embedded-server --target-dir ${target}`
  .cwd(join(root, "network"))
  .env({ ...process.env, TM4_SERVER_BUNDLE: bundle });
const output = join(root, "build/server-release");
const directory = join(output, platform);
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const suffix = process.platform === "win32" ? ".exe" : "";
const name = `rustymetal4-server${suffix}`;
await copyFile(join(target, "release", `tm4-deathmatch-server${suffix}`), join(directory, name));
await chmod(join(directory, name), 0o755);
await copyFile(join(root, "LICENSE"), join(directory, "LICENSE"));
const archive = join(output, `rustymetal4-server-${platform}${suffix ? ".zip" : ".tar.gz"}`);
if (suffix) {
  const quote = (path: string) => `'${path.replaceAll("'", "''")}'`;
  const command = `Compress-Archive -LiteralPath ${quote(join(directory, name))},${quote(join(directory, "LICENSE"))} -DestinationPath ${quote(archive)} -Force`;
  await $`powershell -NoProfile -Command ${command}`.cwd(root);
} else {
  await $`tar -czf ${archive} -C ${directory} ${name} LICENSE`.cwd(root);
}
console.log(`Standalone server: ${join(directory, name)}`);
console.log(`Release archive: ${archive}`);
