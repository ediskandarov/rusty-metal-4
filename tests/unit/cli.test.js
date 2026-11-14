import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { root } from "../../tools/common.js";

const commands = [
  "tools/build.js",
  "tools/serve.js",
  "tools/headless/build.ts",
  "tools/headless/prepare-resources.ts",
  "tools/headless/record-browser.mjs",
  "tools/mods/build.ts",
  "tools/network/build.ts",
  "tools/network/build-server.ts",
  "tools/network/run.ts",
  "tools/network/server.ts",
  "tools/network/serve.ts",
  "tools/prepare/game.js",
  "tools/prepare/psyz.js",
  "tools/prepare/includes.js",
  "tools/prepare/exports.js",
  "tools/resources/reference.ts",
  "tools/resources/validate-car.ts",
  "tools/testing/sqrt-cases.js",
  "tools/web/check-room-catalog.ts",
  "tools/web/deploy.ts",
  "tools/web/format.ts",
  "apps/player/build.ts",
  "apps/server/build.ts",
];

async function run(command, args, env = {}) {
  const child = Bun.spawn([process.execPath, command, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

for (const command of commands) {
  test(`${command}: help and argument errors do not start the command`, async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await run(command, [flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("bun ");
      expect(result.stderr).toBe("");
    }
    const invalid = await run(command, ["--unknown-option"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr.trim()).toMatch(/^error:.*unknown-option/im);
    expect(invalid.stderr.trim().split("\n")).toHaveLength(1);
  });
}

for (const [command, args] of [
  ["tools/network/build.ts", ["--mode"]],
  ["tools/headless/build.ts", ["--mode", "invalid"]],
  ["tools/serve.js", ["--port", "65536"]],
  ["tools/serve.js", ["--port", "abc"]],
  ["tools/network/run.ts", ["9"]],
  ["tools/network/server.ts", ["2", "extra"]],
  ["tools/mods/build.ts", ["one", "two", "extra"]],
  ["tools/headless/prepare-resources.ts", ["one"]],
  ["tools/resources/reference.ts", ["one", "extra"]],
  ["tools/web/check-room-catalog.ts", []],
  ["tools/resources/validate-car.ts", ["--reference-root"]],
  ["tools/resources/validate-car.ts", ["one", "extra"]],
  ["tools/prepare/psyz.js", ["--output", "build/unused"]],
  [
    "tools/prepare/exports.js",
    ["generate", "--manifest", "absent", "--unit", "u", "--output", "unused"],
  ],
  ["tools/prepare/exports.js", ["constructor"]],
]) {
  test(`${command}: rejects ${JSON.stringify(args)}`, async () => {
    const result = await run(command, args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toMatch(/^error:/i);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  });
}

test("export generation preserves compiler arguments after --", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rm4-cli-"));
  try {
    const manifest = join(directory, "manifest.json");
    const output = join(directory, "generated.c");
    const compiler = join(directory, "fake compiler.js");
    const captured = join(directory, "arguments.json");
    const source = join(directory, "source with spaces.c");
    await Bun.write(
      manifest,
      JSON.stringify({
        modules: {},
        units: [{ id: "unit", module: "fixture", modules: [], source }],
      }),
    );
    await Bun.write(
      compiler,
      'await Bun.write(process.env.RM4_CLI_ARGUMENTS, JSON.stringify(Bun.argv.slice(2))); console.log("{}");',
    );
    const result = await run(
      "tools/prepare/exports.js",
      [
        "generate",
        "--manifest",
        manifest,
        "--unit",
        "unit",
        "--output",
        output,
        "--",
        process.execPath,
        compiler,
        "--help",
        "-DNAME=value with spaces",
        "--",
      ],
      { RM4_CLI_ARGUMENTS: captured },
    );
    expect(result.code).toBe(0);
    const args = await Bun.file(captured).json();
    expect(args.slice(0, 3)).toEqual(["--help", "-DNAME=value with spaces", "--"]);
    expect(args.at(-1)).toBe(source);
    expect(await Bun.file(output).exists()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
