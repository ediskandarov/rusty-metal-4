import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { root, run } from "../common.js";

const players = Number(process.argv[2] ?? "2");
if (!Number.isInteger(players) || players < 2 || players > 8)
  throw new Error("Usage: bun run match [2–8]");
const site = new URL(process.env.TM4_WEB_URL ?? "http://127.0.0.1:8120/");
const listen = process.env.TM4_MATCH_LISTEN ?? "127.0.0.1:8122";
const endpoint = process.env.TM4_MATCH_ENDPOINT ?? "ws://127.0.0.1:8122";
const target = join(root, "build/network");
const manifest = join(root, "network/Cargo.toml");
const token = randomBytes(32).toString("hex");
const toolchain = process.env.TM4_RUST_TOOLCHAIN;
const cargo = toolchain ? ["cargo", "+" + toolchain] : ["cargo"];

await run([...cargo, "build", "--locked", "--manifest-path", manifest, "--target-dir", target], {
  cwd: join(root, "network"),
});
const env = {
  ...process.env,
  TM4_WEB_URL: site.href,
  TM4_MATCH_ENDPOINT: endpoint,
  TM4_MATCH_LISTEN: listen,
  TM4_AUTHORITY_TOKEN: token,
  TM4_JOURNAL_DIR: process.env.TM4_JOURNAL_DIR ?? join(root, "build/network-journals"),
};
const executable =
  process.platform === "win32" ? "tm4-deathmatch-server.exe" : "tm4-deathmatch-server";
const server = Bun.spawn([join(target, "debug", executable), String(players)], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
const authority = Bun.spawn([process.execPath, join(root, "tools/network/authority.ts")], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
const joinUrl = new URL(site);
joinUrl.searchParams.set("match", endpoint);
console.log("Join the match from " + joinUrl.href);
console.log("Construction Yard starts when every player is ready and the match clocks agree.");

const stop = () => {
  authority.kill();
  server.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const result = await Promise.race([server.exited, authority.exited]);
  process.exitCode = result;
} finally {
  stop();
}
