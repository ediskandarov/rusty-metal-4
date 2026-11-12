import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { root } from "../../tools/common.js";

const temporary = await mkdtemp(join(tmpdir(), "rm4-shared-cargo-"));
const { toolchain } = Bun.TOML.parse(
  await Bun.file(join(root, "network/rust-toolchain.toml")).text(),
) as { toolchain: { channel: string } };
const cargo = ["cargo", `+${toolchain.channel}`];
try {
  const dependency = join(temporary, "dependency");
  await mkdir(join(dependency, "src"), { recursive: true });
  await Bun.write(
    join(dependency, "Cargo.toml"),
    '[package]\nname="shared-dependency"\nversion="0.1.0"\nedition="2021"\n',
  );
  await Bun.write(join(dependency, "src/lib.rs"), 'pub fn suffix() -> &\'static str { "-ok" }\n');
  for (const name of ["first", "second"]) {
    const directory = join(temporary, name);
    for (const path of ["src", ".cargo", "tools/cache"])
      await mkdir(join(directory, path), { recursive: true });
    await Bun.write(
      join(directory, "Cargo.toml"),
      '[package]\nname="cache-probe"\nversion="0.1.0"\nedition="2021"\n' +
        '[dependencies]\nshared-dependency={path="../dependency"}\n',
    );
    await Bun.write(
      join(directory, "src/main.rs"),
      `fn main() { println!("${name}{}", shared_dependency::suffix()); }\n`,
    );
    const wrapper = join(directory, "tools/cache/rustc.sh");
    await Bun.write(wrapper, Bun.file(join(root, "tools/cache/rustc.sh")));
    await chmod(wrapper, 0o755);
    const config = await Bun.file(join(root, ".cargo/config.toml")).text();
    await Bun.write(
      join(directory, ".cargo/config.toml"),
      config.replace('"build/cargo-cache"', JSON.stringify(join(temporary, "shared"))),
    );
  }
  const build = (name: string) => $`${cargo} build --offline -v`.cwd(join(temporary, name)).quiet();
  const logs = await Promise.all([build("first"), build("second")]);
  assert(logs.some((log) => log.stderr.toString().includes("Fresh shared-dependency")));
  const executable = (name: string) => join(temporary, name, "target/debug/cache-probe");
  for (const name of ["first", "second"])
    assert.equal((await $`${executable(name)}`.text()).trim(), `${name}-ok`);
  await Bun.write(
    join(temporary, "first/src/main.rs"),
    'fn main() { println!("edited{}", shared_dependency::suffix()); }\n',
  );
  await build("first");
  await build("second");
  assert.equal((await $`${executable("first")}`.text()).trim(), "edited-ok");
  assert.equal((await $`${executable("second")}`.text()).trim(), "second-ok");
  console.log("PASS shared dependency reuse, concurrent builds and isolated branch edits");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
