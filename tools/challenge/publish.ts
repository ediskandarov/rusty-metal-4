import { createHmac } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runCli, UsageError } from "../cli.js";
import { assertChallengeRuntime, sha256, verifyRelease } from "./release.ts";

const hmac = (key: string | Uint8Array, value: string) =>
  createHmac("sha256", key).update(value).digest();
export async function putImmutable(options: {
  endpoint: string;
  bucket: string;
  key: string;
  accessKey: string;
  secretKey: string;
  bytes: Uint8Array;
  contentType: string;
  now?: Date;
  fetch?: typeof fetch;
}) {
  const date = (options.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8),
    scope = `${day}/auto/s3/aws4_request`;
  const url = new URL(
    `${options.bucket}/${options.key.split("/").map(encodeURIComponent).join("/")}`,
    options.endpoint.endsWith("/") ? options.endpoint : options.endpoint + "/",
  );
  async function request(method: "PUT" | "GET") {
    const payload = method === "PUT" ? sha256(options.bytes) : sha256("");
    const headers = new Headers({
      "Content-Type": options.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "x-amz-content-sha256": payload,
      "x-amz-date": date,
    });
    if (method === "PUT") headers.set("If-None-Match", "*");
    const signed = [...headers.keys(), "host"].sort();
    const canonical = signed
      .map((name) => `${name}:${name === "host" ? url.host : headers.get(name)}\n`)
      .join("");
    const canonicalRequest = [method, url.pathname, "", canonical, signed.join(";"), payload].join(
      "\n",
    );
    const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
    const key = hmac(
      hmac(hmac(hmac(`AWS4${options.secretKey}`, day), "auto"), "s3"),
      "aws4_request",
    );
    headers.set(
      "Authorization",
      `AWS4-HMAC-SHA256 Credential=${options.accessKey}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${hmac(key, toSign).toString("hex")}`,
    );
    return (options.fetch ?? fetch)(url, {
      method,
      headers,
      ...(method === "PUT" ? { body: options.bytes as BodyInit } : {}),
    });
  }
  const response = await request("PUT");
  if (response.ok) return true;
  if (response.status === 412) {
    // A retry may follow a partly completed release. Reuse only exactly identical bytes;
    // every write still carries the atomic create-only condition, including release.json.
    const existing = await request("GET");
    if (!existing.ok)
      throw new Error(
        `Could not verify existing immutable object ${options.key}: HTTP ${existing.status}`,
      );
    const bytes = new Uint8Array(await existing.arrayBuffer());
    if (
      bytes.length === options.bytes.length &&
      sha256(bytes) === sha256(options.bytes) &&
      bytes.every((byte, index) => byte === options.bytes[index])
    )
      return false;
    throw new Error(`Refusing to overwrite immutable object ${options.key}: existing bytes differ`);
  }
  throw new Error(`R2 upload failed for ${options.key}: HTTP ${response.status}`);
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
        "Requires TM4_R2_ACCOUNT_ID, TM4_R2_ACCESS_KEY_ID, TM4_R2_SECRET_ACCESS_KEY. Does not create a bucket or change the release pin.",
      );
      return;
    }
    if (positionals.length !== 1) throw new UsageError("Supply one frozen release directory");
    const directory = positionals[0]!;
    const manifest = await verifyRelease(directory);
    if (manifest.diagnostic)
      throw new Error(
        "Diagnostic challenge builds are local only; build a release before publishing",
      );
    await assertChallengeRuntime(directory, false);
    const account = process.env.TM4_R2_ACCOUNT_ID;
    const accessKey = process.env.TM4_R2_ACCESS_KEY_ID;
    const secretKey = process.env.TM4_R2_SECRET_ACCESS_KEY;
    if (!account || !/^[a-f0-9]{32}$/.test(account) || !accessKey || !secretKey)
      throw new Error("Set the three TM4_R2 credentials described by --help");
    for (const file of [
      ...manifest.files,
      { path: "release.json", contentType: "application/json" },
    ]) {
      const created = await putImmutable({
        endpoint: `https://${account}.r2.cloudflarestorage.com`,
        bucket: values.bucket,
        key: `${manifest.buildId}/${file.path}`,
        accessKey,
        secretKey,
        contentType: file.contentType,
        bytes: new Uint8Array(await Bun.file(join(directory, file.path)).arrayBuffer()),
      });
      console.log(`${created ? "Published" : "Verified existing"} ${file.path}`);
    }
    console.log(
      `Published complete immutable release ${manifest.buildId}. Pin it explicitly in config/challenge-release.json, then deploy only the website when authorized.`,
    );
  });
