import { join, resolve } from "node:path";

import { $ } from "bun";

import { UsageError } from "../cli.js";
import { root } from "../common.js";

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

export const releaseBucket = "rm4-challenge-releases";
const target = ["--remote", "--config", join(root, "apps/rustymetal4.com/wrangler.jsonc")];

function failure(action: string, object: string, result: { stderr: Uint8Array }) {
  return new UsageError(
    `Wrangler could not ${action} ${object}: ${new TextDecoder().decode(result.stderr).trim()}`,
  );
}

export async function readReleaseObject(object: string, run: WranglerCommand = wrangler) {
  const result = await run(["r2", "object", "get", object, "--pipe", ...target]);
  if (result.exitCode === 0) return result.stdout;
  // Only an explicit missing-key response permits a write.
  if (new TextDecoder().decode(result.stderr).includes("The specified key does not exist."))
    return null;
  throw failure("read", object, result);
}

export async function publishObject(
  options: { bucket: string; key: string; file: string; contentType: string },
  run: WranglerCommand = wrangler,
) {
  const object = `${options.bucket}/${options.key}`;
  const bytes = new Uint8Array(await Bun.file(options.file).arrayBuffer());
  const sameBytes = (other: Uint8Array) =>
    bytes.length === other.length && bytes.every((byte, i) => byte === other[i]);
  const existing = await readReleaseObject(object, run);
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
  if (result.exitCode !== 0) throw failure("upload", object, result);
  const uploaded = await readReleaseObject(object, run);
  if (uploaded === null || !sameBytes(uploaded))
    throw new UsageError(`Uploaded object verification failed: ${object}`);
  return true;
}
