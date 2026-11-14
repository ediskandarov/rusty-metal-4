import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { runCli } from "../cli.js";
import { root } from "../common.js";

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
    if (!values["prepare-only"]) await $`docker info > /dev/null`;
    await $`bun run build`.cwd(root);
    await $`bun run test:pages`.cwd(root);
    await $`bun run build:rustymetal4.com`.cwd(root);
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
