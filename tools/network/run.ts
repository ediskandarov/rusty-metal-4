import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { runCli, UsageError } from "../cli.js";
import { root } from "../common.js";

await runCli(async () => {
  const { values, positionals } = parseArgs({
    strict: true,
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      diagnostic: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: bun run match [1–8] [--diagnostic]");
    return;
  }
  const mode = values.diagnostic ? "diagnostic" : "dev";
  const players = Number(positionals[0] ?? "2");
  if (positionals.length > 1 || !Number.isInteger(players) || players < 1 || players > 8)
    throw new UsageError("Usage: bun run match [1–8] [--diagnostic]");
  const site = new URL(process.env.TM4_WEB_URL ?? "http://127.0.0.1:8120/");
  const listen = process.env.TM4_MATCH_LISTEN ?? "127.0.0.1:8122";
  const endpoint = process.env.TM4_MATCH_ENDPOINT ?? "ws://127.0.0.1:8122";
  const target = join(root, "build/network-native");
  const manifest = join(root, "network/Cargo.toml");
  const cargo = process.env.TM4_RUST_TOOLCHAIN
    ? ["cargo", "+" + process.env.TM4_RUST_TOOLCHAIN]
    : ["cargo"];
  const features = values.diagnostic ? ["--features", "rollback_probe"] : [];
  await $`${cargo} build --locked --manifest-path ${manifest} --target-dir ${target} ${features}`.cwd(
    join(root, "network"),
  );
  const executable =
    process.platform === "win32" ? "tm4-deathmatch-server.exe" : "tm4-deathmatch-server";
  const server = Bun.spawn([join(target, "debug", executable), String(players)], {
    env: {
      ...process.env,
      TM4_MATCH_LISTEN: listen,
      TM4_SIMULATION_BUILD: resolve(
        root,
        process.env.TM4_SIMULATION_BUILD ?? `build/${mode}/server/simulation-build.json`,
      ),
      TM4_SIMULATION_WASM: resolve(
        root,
        process.env.TM4_SIMULATION_WASM ?? `build/${mode}/server/tm4_standalone.wasm`,
      ),
      TM4_RESOURCE_DIR: resolve(root, process.env.TM4_RESOURCE_DIR ?? "build/resources"),
      TM4_JOURNAL_DIR: process.env.TM4_JOURNAL_DIR ?? join(root, "build/network-journals"),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = (async () => {
    let pending = "";
    let announced = false;
    for await (const chunk of server.stdout) {
      process.stdout.write(chunk);
      pending += new TextDecoder().decode(chunk);
      if (!announced && pending.includes("Lightyear listening on")) {
        announced = true;
        const joinUrl = new URL(site);
        joinUrl.searchParams.set("match", endpoint);
        console.log("Join the match from " + joinUrl.href);
        console.log("The match starts when every player is ready and the match clocks agree.");
      }
      if (pending.length > 8192) pending = pending.slice(-4096);
    }
  })();
  const stop = () => server.kill();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await server.exited;
    await output;
  } finally {
    stop();
  }
});
