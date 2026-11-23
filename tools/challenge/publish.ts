import { join } from "node:path";
import { parseArgs } from "node:util";

import { runCli, UsageError } from "../cli.js";
import { publishObject, releaseBucket } from "../web/release-objects.ts";
import { assertChallengeRuntime, verifyRelease } from "./release.ts";

if (import.meta.main)
  await runCli(async () => {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        bucket: { type: "string", default: releaseBucket },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log("bun tools/challenge/publish.ts RELEASE_DIRECTORY [--bucket NAME]");
      console.log(
        "Uses Wrangler authentication (bunx wrangler login). Does not create a bucket or change the release pin.",
      );
      return;
    }
    if (positionals.length !== 1) throw new UsageError("Supply one frozen release directory");
    const directory = positionals[0]!;
    const manifest = await verifyRelease(directory);
    if (manifest.diagnostic)
      throw new UsageError(
        "Diagnostic challenge builds are local only; build a release before publishing",
      );
    await assertChallengeRuntime(directory, false);
    for (const file of [
      ...manifest.files,
      { path: "release.json", contentType: "application/json" },
    ]) {
      const created = await publishObject({
        bucket: values.bucket,
        key: `${manifest.buildId}/${file.path}`,
        file: join(directory, file.path),
        contentType: file.contentType,
      });
      console.log(`${created ? "Published" : "Verified existing"} ${file.path}`);
    }
    console.log(
      `Published complete release ${manifest.buildId}. Pin it in config/challenge-release.json, then deploy the website.`,
    );
  });
