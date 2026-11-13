import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { build } from "astro";
import { $ } from "bun";

import { root } from "../common.js";

export async function buildSite(
  app: "player" | "server" | "rustymetal4.com",
  mode: "release" | "dev" | "diagnostic",
  site: string,
) {
  const commit = (await $`git rev-parse HEAD`.cwd(root).text()).trim();
  const output = join(root, "build", mode, "astro", app);
  await build({
    root: join(root, "apps", app),
    configFile: false,
    outDir: output,
    cacheDir: join(root, "build", mode, "astro-cache", app),
    output: "static",
    build: { assetsPrefix: app === "rustymetal4.com" ? undefined : "." },
    vite: {
      define: {
        TM4_DEV: JSON.stringify(mode !== "release"),
        "import.meta.env.PUBLIC_BUILD_COMMIT": JSON.stringify(commit),
      },
      build: { target: "esnext", sourcemap: mode === "diagnostic", minify: mode !== "diagnostic" },
    },
  });
  // Astro owns only the frontend. Preserve the separately compiled C/Rust Wasm beside it.
  await mkdir(site, { recursive: true });
  await rm(join(site, "_astro"), { recursive: true, force: true });
  await cp(output, site, { recursive: true });
}
