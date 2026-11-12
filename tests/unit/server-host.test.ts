import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frontend } from "../../apps/cloudflare/src/assets.ts";
import { serveHost } from "../../tools/network/serve.ts";

test("the separate frontend serves ranges, isolates Wasm and proxies only API requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rustymetal4-frontend-"));
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      return Response.json({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
    },
  });
  let host: Awaited<ReturnType<typeof serveHost>> | undefined;
  try {
    await Bun.write(join(directory, "site/index.html"), "<title>host</title>");
    await Bun.write(join(directory, "site/runtime.wasm"), new Uint8Array([0, 97, 115, 109, 1]));
    await Bun.write(join(directory, "private.txt"), "must stay private");
    await symlink(join(directory, "private.txt"), join(directory, "site/escape"));
    host = await serveHost({ site: join(directory, "site"), api: api.url.href, port: 0 });
    const request = (path: string, init?: RequestInit) => fetch(new URL(path, host!.url), init);
    const home = await request("/");
    expect(home.status).toBe(200);
    expect(home.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    const range = await request("/runtime.wasm", { headers: { Range: "bytes=0-3" } });
    expect(range.status).toBe(206);
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([0, 97, 115, 109]);
    const head = await request("/runtime.wasm", { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("5");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    for (const path of ["/escape", "/%2e%2e%2fprivate.txt", "/missing"])
      expect((await request(path)).status).toBe(404);
    expect((await request("/index.html", { method: "POST" })).status).toBe(405);
    const forwarded = await request("/api/prepare", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
      body: "fixture",
    });
    expect(await forwarded.json()).toEqual({
      path: "/api/prepare",
      authorization: "Bearer test-secret",
      body: "fixture",
    });
    await api.stop(true);
    expect((await request("/api/status")).status).toBe(503);
  } finally {
    await host?.stop(true);
    await api.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Worker Assets responses preserve range headers and add browser isolation", async () => {
  const assets = {
    fetch() {
      return Promise.resolve(
        new Response(new Uint8Array([0, 97]), {
          status: 206,
          headers: { "Content-Range": "bytes 0-1/10", "Content-Type": "application/wasm" },
        }),
      );
    },
  };
  const response = await frontend(assets, new Request("https://example.com/play/runtime.wasm"));
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe("bytes 0-1/10");
  expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  expect(
    (await frontend(assets, new Request("https://example.com/", { method: "POST" }))).status,
  ).toBe(405);
});
