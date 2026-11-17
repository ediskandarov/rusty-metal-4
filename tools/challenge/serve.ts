import { parseArgs } from "node:util";

import { runCli, UsageError } from "../cli.js";
import { challengeRuntime } from "./local.ts";

await runCli(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "8362" },
      site: { type: "string", default: "build/release/rustymetal4.com-site" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "bun tools/challenge/serve.ts FROZEN_RELEASE [--port 8362] [--site WEBSITE_DIRECTORY]",
    );
    console.log("Uses local-only R2 and leaderboard storage. Nothing is published.");
    return;
  }
  const port = Number(values.port);
  if (positionals.length !== 1 || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new UsageError("Supply one frozen release and a valid local port");
  const mf = await challengeRuntime({
    release: positionals[0],
    site: values.site,
    port,
    persist: true,
  });
  console.log(`Local 200 Challenge: ${new URL("/200-challenge", await mf.ready)}`);
  const stop = async () => {
    await mf.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await new Promise(() => {});
});
