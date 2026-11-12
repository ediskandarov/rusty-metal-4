import { join, resolve } from "node:path";

import { Miniflare } from "miniflare";

export async function runtime(assets = false) {
  const directory = resolve("build/room-tests");
  const build = await Bun.build({
    entrypoints: ["tests/rooms/worker.ts"],
    outdir: directory,
    target: "browser",
    external: ["cloudflare:workers"],
    naming: "worker.mjs",
  });
  if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"));
  const mf = new Miniflare({
    port: 0,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "room-tests",
          compatibilityDate: "2026-11-11",
          manifest: {
            mainModule: "worker.mjs",
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: await Bun.file(join(directory, "worker.mjs")).text(),
              },
            },
          },
          env: {
            ROOMS: { type: "durable-object", worker: "room-tests", exportName: "Room" },
            DIRECTORY: {
              type: "durable-object",
              worker: "room-tests",
              exportName: "RoomDirectory",
            },
            CREATION_LIMIT: {
              type: "rate-limit",
              namespace: "1001",
              simple: { limit: 5, period: 60 },
            },
            REQUEST_LIMIT: {
              type: "rate-limit",
              namespace: "1002",
              simple: { limit: 60, period: 60 },
            },
            ...(assets ? { ASSETS: { type: "assets" as const } } : {}),
          },
          exports: {
            Room: { type: "durable-object", storage: "sqlite" },
            RoomDirectory: { type: "durable-object", storage: "sqlite" },
          },
          ...(assets
            ? {
                assets: {
                  directory: resolve("build/release/rustymetal4.com-site"),
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
  return mf;
}
export async function eventually<T>(
  operation: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 5000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await operation();
    if (accept(value)) return value;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Condition did not become true within ${timeout}ms: ${JSON.stringify(value)}`);
}
