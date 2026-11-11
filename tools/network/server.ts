import { join } from "node:path";
import { parseArgs } from "node:util";

import { root, run } from "../common.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { mode: { type: "string", default: "dev" } },
});
const mode = values.mode;
if (mode !== "dev" && mode !== "release" && mode !== "diagnostic")
  throw new Error("Choose --mode release, dev or diagnostic");
const players = Number(positionals[0] ?? "2");
if (positionals.length > 1 || !Number.isInteger(players) || players < 2 || players > 8)
  throw new Error("Usage: bun run server [2–8] [--mode dev|release|diagnostic]");
if (!process.env.TM4_ADMIN_SECRET || process.env.TM4_ADMIN_SECRET.length < 24)
  throw new Error("Set TM4_ADMIN_SECRET to a private startup secret of at least 24 characters");
const target = join(root, "build/network-native");
const profile = mode === "release" ? "release" : "debug";
await run(
  [
    "cargo",
    "build",
    "--locked",
    "--bin",
    "tm4-deathmatch-server",
    "--target-dir",
    target,
    ...(mode === "release" ? ["--release"] : []),
    ...(mode === "diagnostic" ? ["--features", "rollback_probe"] : []),
  ],
  { cwd: join(root, "network") },
);
const directory = join(root, "build", mode, "server");
const executable =
  process.platform === "win32" ? "tm4-deathmatch-server.exe" : "tm4-deathmatch-server";
const server = Bun.spawn([join(target, profile, executable), "--serve", String(players)], {
  env: {
    ...process.env,
    TM4_SERVER_SITE_DIR: process.env.TM4_SERVER_SITE_DIR ?? join(directory, "site"),
    TM4_SIMULATION_WASM: process.env.TM4_SIMULATION_WASM ?? join(directory, "tm4_standalone.wasm"),
    TM4_JOURNAL_DIR: process.env.TM4_JOURNAL_DIR ?? join(root, "build/network-journals"),
  },
  stdout: "inherit",
  stderr: "inherit",
});
const stop = () => server.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.exitCode = await server.exited;
