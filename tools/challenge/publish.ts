import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { runCli, UsageError } from "../cli.js";
import { root } from "../common.js";
import { assertChallengeRuntime, verifyRelease } from "./release.ts";

export type WranglerCommand = (args: string[]) => Promise<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;
const wrangler: WranglerCommand = (args) =>
  $`bunx --no-install wrangler ${args}`
    .cwd(root)
    .env({ ...process.env, CI: "true", NO_COLOR: "1" })
    .quiet()
    .nothrow();

export async function publishObject(
  options: { bucket: string; key: string; file: string; contentType: string },
  run: WranglerCommand = wrangler,
) {
  const object = `${options.bucket}/${options.key}`;
  const target = ["--remote", "--config", join(root, "apps/rustymetal4.com/wrangler.jsonc")];
  const bytes = new Uint8Array(await Bun.file(options.file).arrayBuffer());
  const sameBytes = (other: Uint8Array) =>
    bytes.length === other.length && bytes.every((byte, i) => byte === other[i]);
  const failure = (action: string, result: { stderr: Uint8Array }) =>
    new UsageError(
      `Wrangler could not ${action} ${object}: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  const read = async () => {
    const result = await run(["r2", "object", "get", object, "--pipe", ...target]);
    if (result.exitCode === 0) return result.stdout;
    // Only an explicit missing-key response permits a write. Auth/network errors stop it.
    if (new TextDecoder().decode(result.stderr).includes("The specified key does not exist."))
      return null;
    throw failure("read", result);
  };
  const existing = await read();
  if (existing !== null) {
    if (!sameBytes(existing))
      throw new UsageError(`Refusing to overwrite ${object}: existing bytes differ`);
    return false;
  }
  // Wrangler has no conditional-create flag; the build hash fixes the expected bytes at each key.
  const result = await run([
    "r2",
    "object",
    "put",
    object,
    "--file",
    resolve(options.file),
    "--content-type",
    options.contentType,
    "--cache-control",
    "public, max-age=31536000, immutable",
    ...target,
  ]);
  if (result.exitCode !== 0) throw failure("upload", result);
  const uploaded = await read();
  if (uploaded === null || !sameBytes(uploaded))
    throw new UsageError(`Uploaded object verification failed: ${object}`);
  return true;
}

if (import.meta.main)
  await runCli(async () => {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        bucket: { type: "string", default: "rm4-challenge-releases" },
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
