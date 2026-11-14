/// <reference types="bun" />
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runCli, UsageError } from "../../tools/cli.js";
import { buildSite } from "../../tools/web/build.ts";

export type PlayerMode = "release" | "dev" | "diagnostic";
const root = resolve(import.meta.dir, "../..");

// Bundle the player independently of the CMake and Cargo runtime builds.
export async function buildPlayer({ mode, site }: { mode: PlayerMode; site: string }) {
  const diagnostic = mode === "diagnostic";
  await mkdir(site, { recursive: true });
  await buildSite("player", mode, site);
  // Remove artifacts from the former handwritten HTML/Bun bundle.
  await rm(join(site, "web.js"), { force: true });
  await rm(join(site, "web.js.map"), { force: true });
  await rm(join(site, "styles"), { recursive: true, force: true });
  if (diagnostic) {
    const probe = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve("@tm4/game-runtime/network/rollbackProbe"))],
      outdir: site,
      naming: "rollback-probe.js",
      target: "browser",
    });
    if (!probe.success) throw new AggregateError(probe.logs, "Rollback probe bundle failed");
  }
  await cp(
    join(root, "node_modules/coi-serviceworker/coi-serviceworker.min.js"),
    join(site, "coi-serviceworker.js"),
  );
  await cp(
    join(root, "node_modules/coi-serviceworker/LICENSE"),
    join(site, "coi-serviceworker.LICENSE.txt"),
  );
}

if (import.meta.main) {
  await runCli(async () => {
    const { values } = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        mode: { type: "string", default: "release" },
      },
    });
    if (values.help) {
      console.log("Usage: bun run build:player [--mode release|dev|diagnostic]");
      return;
    }
    const mode = values.mode;
    if (mode !== "release" && mode !== "dev" && mode !== "diagnostic")
      throw new UsageError("Choose --mode release, dev or diagnostic");
    const site = join(root, "build", mode, "site");
    await buildPlayer({ mode, site });
    console.log(`Built player (${mode}): ${site}`);
  });
}
