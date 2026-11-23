import { join, resolve } from "node:path";

import { Miniflare } from "miniflare";

import { root } from "../common.js";
import { verifyRelease } from "./release.ts";

export async function challengeRuntime(
  options: { release?: string; site?: string; port?: number; persist?: boolean } = {},
) {
  const manifest = options.release ? await verifyRelease(options.release) : null;
  const bundle = await Bun.build({
    entrypoints: [join(root, "apps/rustymetal4.com/src/worker/index.ts")],
    target: "browser",
    external: ["cloudflare:workers"],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle challenge Worker");
  const mf = new Miniflare({
    port: options.port ?? 0,
    telemetry: { enabled: false },
    ...(options.persist
      ? { isolatedResourcePersistencePath: join(root, "build/challenge-local-state") }
      : {}),
    workers: [
      {
        config: {
          name: "challenge-local",
          compatibilityDate: "2026-11-11",
          manifest: {
            mainModule: "worker.mjs",
            modules: { "worker.mjs": { type: "esm", contents: await bundle.outputs[0]!.text() } },
          },
          env: {
            CHALLENGE: {
              type: "durable-object",
              worker: "challenge-local",
              exportName: "ChallengeLeaderboard",
            },
            RELEASES: { type: "r2" },
            CHALLENGE_BUILD_ID: { type: "text", value: manifest?.buildId ?? "" },
            ...(options.site ? { ASSETS: { type: "assets" } } : {}),
          },
          exports: { ChallengeLeaderboard: { type: "durable-object", storage: "sqlite" } },
          ...(options.site
            ? {
                assets: {
                  directory: resolve(options.site),
                  hasUserWorker: true,
                  runWorkerFirst: true,
                },
              }
            : {}),
        },
      },
    ],
  });
  await mf.ready;
  if (manifest && options.release) {
    // Miniflare's mapped Node types currently infer an unrelated Request for this binding.
    const bucket = (await mf.getR2Bucket("RELEASES", "challenge-local")) as unknown as {
      put(
        key: string,
        bytes: Uint8Array,
        options: { httpMetadata: { contentType: string } },
      ): Promise<unknown>;
    };
    for (const file of [
      ...manifest.files,
      { path: "release.json", contentType: "application/json" },
    ])
      await bucket.put(
        `${manifest.buildId}/${file.path}`,
        new Uint8Array(await Bun.file(join(options.release, file.path)).arrayBuffer()),
        { httpMetadata: { contentType: file.contentType } },
      );
  }
  return mf;
}
