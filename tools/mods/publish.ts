import { join } from "node:path";
import { parseArgs } from "node:util";

import { tm3ConverterPath } from "@tm4/mods/converter-paths";

import { runCli, UsageError } from "../cli.js";
import { publishObject, releaseBucket } from "../web/release-objects.ts";
import { verifyConverter } from "./converter.ts";

await runCli(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log("bun run publish:tm3-converter RELEASE_DIRECTORY");
    return;
  }
  if (positionals.length !== 1) throw new UsageError("Supply one frozen TM3 converter directory");
  const directory = positionals[0]!;
  const { digest, release } = await verifyConverter(directory);
  for (const { path, contentType } of [
    ...release.files.map(({ path }) => ({
      path,
      contentType: path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
    })),
    { path: "release.json", contentType: "application/json" },
  ]) {
    const created = await publishObject({
      bucket: releaseBucket,
      key: tm3ConverterPath.slice(1) + digest + "/" + path,
      file: join(directory, path),
      contentType,
    });
    console.log(`${created ? "Published" : "Verified existing"} ${path}`);
  }
  console.log(
    `Published ${release.version} (${digest}). Set digest in config/tm3-converter-release.json.`,
  );
});
