import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $, Glob } from "bun";

import { runCli, UsageError } from "../cli.js";
import { buildPath, root } from "../common.js";
await runCli(async () => {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      source: { type: "string" },
      output: { type: "string" },
    },
  });
  if (values.help) {
    console.log("Usage: bun tools/prepare/psyz.js --source PATH --output PATH");
    return;
  }
  if (!values["source"] || !values["output"])
    throw new UsageError("bun tools/prepare/psyz.js --source PATH --output PATH");
  const { source, output: requested } = values;
  const output = await buildPath(requested);
  await rm(output, { recursive: true, force: true });
  await cp(source, output, { recursive: true });
  const patches = await Array.fromAsync(
    new Glob("*.patch").scan({ cwd: join(root, "port/psyz/patches"), dot: true }),
  );
  for (const name of patches.sort()) {
    const patch = join(root, "port/psyz/patches", name);
    await $`patch --batch --fuzz=0 -p1 -i ${patch}`.cwd(output);
  }
});
