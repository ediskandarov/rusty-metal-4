import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolationHeaders, serveFile, staticFile } from "../../tools/server/files.js";

let directory: string;
let site: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tm4-http-files-"));
  site = join(directory, "site");
  await mkdir(site);
  site = await realpath(site);
  await Bun.write(join(site, "track.bin"), "0123456789");
  await Bun.write(join(site, "empty.bin"), "");
  await Bun.write(join(directory, "private.bin"), "private");
  await symlink(join(directory, "private.bin"), join(site, "escape.bin"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const file = await staticFile(site, new URL(request.url).pathname);
      if (!file || !(await file.exists())) return new Response(null, { status: 404 });
      return serveFile(file);
    },
  });
});

afterAll(async () => {
  await server?.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.each([
  ["bytes=0-3", "0123", "bytes 0-3/10"],
  ["bytes=2-99", "23456789", "bytes 2-9/10"],
  ["bytes=7-", "789", "bytes 7-9/10"],
  ["bytes=-3", "789", "bytes 7-9/10"],
])("Bun serves file range %s over HTTP", async (range, body, contentRange) => {
  const response = await fetch(new URL("track.bin", server.url), { headers: { Range: range } });
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe(contentRange);
  expect(response.headers.get("Content-Length")).toBe(String(body.length));
  expect(response.headers.get("Accept-Ranges")).toBe("bytes");
  expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  for (const [name, value] of Object.entries(isolationHeaders))
    expect(response.headers.get(name)).toBe(value);
  expect(await response.text()).toBe(body);
});

test("Bun rejects unsatisfiable ranges without returning file contents", async () => {
  for (const [name, range, size] of [
    ["track.bin", "bytes=10-", 10],
    ["track.bin", "bytes=-0", 10],
    ["empty.bin", "bytes=0-", 0],
  ] as const) {
    const response = await fetch(new URL(name, server.url), { headers: { Range: range } });
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${size}`);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  }
});

test("HEAD ignores Range and describes the complete file without a body", async () => {
  for (const range of [undefined, "bytes=0-3", "bytes=999-"]) {
    const response = await fetch(new URL("track.bin", server.url), {
      method: "HEAD",
      headers: range ? { Range: range } : {},
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Content-Range")).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  }
});

test("unsupported or malformed Range falls back to the complete file", async () => {
  for (const range of ["invalid", "bytes=0-1,4-5"]) {
    const response = await fetch(new URL("track.bin", server.url), { headers: { Range: range } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(await response.text()).toBe("0123456789");
  }
});

test("static file resolution still rejects traversal and outside symlinks", async () => {
  expect(await staticFile(site, "/../private.bin")).toBeNull();
  const response = await fetch(new URL("escape.bin", server.url));
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("private");
});
