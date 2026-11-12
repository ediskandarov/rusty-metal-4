import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { build } from "astro";

import { root } from "../common.js";

export async function buildSite(
  app: "player" | "server",
  mode: "release" | "dev" | "diagnostic",
  site: string,
) {
  const output = join(root, "build", mode, "astro", app);
  await build({
    root: join(root, "apps", app),
    configFile: false,
    outDir: output,
    cacheDir: join(root, "build", mode, "astro-cache", app),
    output: "static",
    build: { assetsPrefix: "." },
    vite: {
      define: { TM4_DEV: JSON.stringify(mode !== "release") },
      build: { target: "esnext", sourcemap: mode === "diagnostic", minify: mode !== "diagnostic" },
    },
  });
  // Astro owns only the frontend. Preserve the separately compiled C/Rust Wasm beside it.
  await mkdir(site, { recursive: true });
  await rm(join(site, "_astro"), { recursive: true, force: true });
  await cp(output, site, { recursive: true });
}
