import { join } from "node:path";
import { parseArgs } from "node:util";

import { tm3ConverterPath } from "@tm4/mods/converter-paths";
import { converterPinSchema, readConverterRelease } from "@tm4/mods/recipe";
import { $ } from "bun";

import { runCli, UsageError } from "../cli.js";
import { root } from "../common.js";
import { readReleaseObject, releaseBucket } from "./release-objects.ts";

async function verifyPublishedConverter() {
  const site = join(root, "build/release/rustymetal4.com-site");
  const pin = Bun.file(join(site, tm3ConverterPath, "pin.json"));
  const { digest } = converterPinSchema.parse(await pin.json());
  const key = `${releaseBucket}${tm3ConverterPath}${digest}/release.json`;
  const manifest = await readReleaseObject(key);
  if (!manifest) throw new UsageError("Publish the pinned TM3 converter before deploying.");
  const release = await readConverterRelease(new Uint8Array(manifest), digest);
  const player = Bun.file(join(site, "play/simulation-build.json"));
  const { sha256: runtime } = (await player.json()) as { sha256: string };
  if (release.runtime !== runtime)
    throw new UsageError(
      "The pinned TM3 converter targets another runtime. Publish a compatible release and update config/tm3-converter-release.json.",
    );
}

await runCli(async () => {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      "prepare-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("bun run deploy:prepare — build and check the release without publishing");
    console.log("bun run deploy — build, check and publish rustymetal4.com");
  } else {
    if (!values["prepare-only"] && process.env.TM4_TM3_CONVERTER)
      throw new UsageError(
        "TM4_TM3_CONVERTER is a local preview override. Unset it before deploying.",
      );
    if (!values["prepare-only"]) await $`docker info > /dev/null`;
    await $`bun run build`.cwd(root);
    await $`bun run test:pages`.cwd(root);
    await $`bun run build:rustymetal4.com`.cwd(root);
    if (!values["prepare-only"]) await verifyPublishedConverter();
    await $`bun test tests/unit/room-state.test.ts`.cwd(root);
    await $`bun run test:rooms`.cwd(root);
    await $`bun run test:rooms:browser`.cwd(root);
    if (values["prepare-only"]) {
      console.log("Release prepared and checked. Nothing published.");
    } else {
      await $`bunx --no-install wrangler deploy`.cwd(join(root, "apps/rustymetal4.com"));
    }
  }
});
