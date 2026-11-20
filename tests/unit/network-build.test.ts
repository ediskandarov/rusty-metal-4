import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { root } from "../../tools/common.js";

const expected = "0.2.114";
const bindgenSource = `#!${process.execPath}
import { appendFile } from "node:fs/promises";
if (process.argv[2] === "--version") {
  const version = await Bun.file(import.meta.dir + "/version").text();
  if (version === "broken") process.exit(1);
  console.log("wasm-bindgen " + version);
} else {
  await appendFile(process.env.TM4_TEST_LOG, JSON.stringify(["bindgen", ...process.argv.slice(2)]) + "\\n");
}
`;

async function runBuild(installed?: string, requirement = `=${expected}`, replacement = expected) {
  const directory = await mkdtemp(join(tmpdir(), "rm4 network build "));
  try {
    for (const path of [
      "tools/common.js",
      "tools/cli.js",
      "tools/network/build.ts",
      "tools/rust/wasm-bindgen.ts",
    ])
      await Bun.write(join(directory, path), await Bun.file(join(root, path)).text());
    await Bun.write(
      join(directory, "network/Cargo.toml"),
      `[dependencies]\nwasm-bindgen = "${requirement}"\n`,
    );
    const tools = join(directory, "build/rust-tools/bin");
    const bindgen = join(tools, process.platform === "win32" ? "wasm-bindgen.exe" : "wasm-bindgen");
    if (installed) {
      await Bun.write(bindgen, bindgenSource);
      await chmod(bindgen, 0o755);
      await Bun.write(join(tools, "version"), installed);
    }
    const cargo = join(directory, "bin/cargo");
    await Bun.write(
      cargo,
      `#!${process.execPath}
import { appendFile, chmod } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.TM4_TEST_LOG, JSON.stringify(["cargo", ...args]) + "\\n");
if (args[0] === "install") {
  await Bun.write(${JSON.stringify(bindgen)}, ${JSON.stringify(bindgenSource)});
  await chmod(${JSON.stringify(bindgen)}, 0o755);
  await Bun.write(${JSON.stringify(join(tools, "version"))}, ${JSON.stringify(replacement)});
}
`,
    );
    await chmod(cargo, 0o755);
    const log = join(directory, "commands.jsonl");
    await Bun.write(log, "");
    const child = Bun.spawn([process.execPath, "tools/network/build.ts", "--mode", "dev"], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: join(directory, "bin") + delimiter + process.env.PATH,
        TM4_TEST_LOG: log,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const commands = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    return { code, stdout, stderr, commands };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const installed of [undefined, expected, "0.2.113", "0.2.130", "broken"]) {
  test(`network build selects the pinned CLI with installed version ${installed ?? "missing"}`, async () => {
    const result = await runBuild(installed);
    expect(result.code).toBe(0);
    const installs = result.commands.filter((args) => args[0] === "cargo" && args[1] === "install");
    expect(installs).toHaveLength(installed === expected ? 0 : 1);
    if (installs.length) {
      const args = installs[0]!;
      expect(args[2]).toBe("wasm-bindgen-cli");
      expect(args[args.indexOf("--version") + 1]).toBe(`=${expected}`);
      expect(args).toContain("--locked");
      expect(args).toContain("--force");
    }
    expect(result.commands.at(-2)?.slice(0, 2)).toEqual(["cargo", "build"]);
    expect(result.commands.at(-1)?.[0]).toBe("bindgen");
  });
}

test("network build rejects an unpinned dependency before invoking tools", async () => {
  const result = await runBuild(expected, "^0.2.114");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Pin wasm-bindgen to an exact release");
  expect(result.commands).toEqual([]);
});

test("network build verifies installation before compiling the client", async () => {
  const result = await runBuild("0.2.113", `=${expected}`, "0.2.113");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("does not report expected version");
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]?.slice(0, 2)).toEqual(["cargo", "install"]);
});
