import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { runCli, UsageError } from "../cli.js";
import { root } from "../common.js";
import { serveHost } from "./serve.ts";

await runCli(async () => {
  const { values, positionals } = parseArgs({
    strict: true,
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, mode: { type: "string", default: "dev" } },
  });
  if (values.help) {
    console.log("Usage: bun run server [1–8] [--mode dev|release|diagnostic]");
    return;
  }
  const mode = values.mode;
  if (mode !== "dev" && mode !== "release" && mode !== "diagnostic")
    throw new UsageError("Choose --mode release, dev or diagnostic");
  const players = Number(positionals[0] ?? "2");
  if (positionals.length > 1 || !Number.isInteger(players) || players < 1 || players > 8)
    throw new UsageError("Usage: bun run server [1–8] [--mode dev|release|diagnostic]");
  if (!process.env.TM4_ADMIN_SECRET || process.env.TM4_ADMIN_SECRET.length < 24)
    throw new Error("Set TM4_ADMIN_SECRET to a private startup secret of at least 24 characters");
  const target = join(root, "build/network-native");
  const profile = mode === "release" ? "release" : "debug";
  const release = mode === "release" ? ["--release"] : [];
  const features = mode === "diagnostic" ? ["--features", "rollback_probe"] : [];
  await $`cargo build --locked --bin tm4-deathmatch-server --target-dir ${target} ${release} ${features}`.cwd(
    join(root, "network"),
  );
  const directory = join(root, "build", mode, "server");
  const executable =
    process.platform === "win32" ? "tm4-deathmatch-server.exe" : "tm4-deathmatch-server";
  const host = await serveHost({
    site: join(root, "build", mode, "server-site"),
    api: `http://${process.env.TM4_HTTP_LISTEN ?? "127.0.0.1:8121"}`,
    port: Number(process.env.TM4_HOST_PORT ?? 8120),
  });
  console.log(`Server web app: ${host.url}`);
  const server = Bun.spawn([join(target, profile, executable), "--serve", String(players)], {
    env: {
      ...process.env,
      TM4_HTTP_LISTEN: process.env.TM4_HTTP_LISTEN ?? "127.0.0.1:8121",
      TM4_SIMULATION_BUILD:
        process.env.TM4_SIMULATION_BUILD ?? join(directory, "simulation-build.json"),
      TM4_SIMULATION_WASM:
        process.env.TM4_SIMULATION_WASM ?? join(directory, "tm4_standalone.wasm"),
      TM4_JOURNAL_DIR: process.env.TM4_JOURNAL_DIR ?? join(root, "build/network-journals"),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = () => server.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await server.exited;
  } finally {
    await host.stop(true);
  }
});
