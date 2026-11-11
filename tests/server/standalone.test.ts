import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = process.env.TM4_SERVER_EXECUTABLE;
if (!executable) throw new Error("Set TM4_SERVER_EXECUTABLE to the standalone binary");
const directory = await mkdtemp(join(tmpdir(), "tm4-standalone-test-"));
const binary = join(directory, process.platform === "win32" ? "server.exe" : "server");
const secret = crypto.randomUUID();
const port = Number(process.env.TM4_SERVER_TEST_PORT ?? 18920);
const address = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;
let output: Promise<void>;
let logs = "";

beforeAll(async () => {
  await copyFile(resolve(executable), binary);
  await chmod(binary, 0o755);
  await mkdir(join(directory, "private"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("TM4_")) delete env[key];
  server = Bun.spawn([binary], {
    cwd: directory,
    env: {
      ...env,
      TM4_ADMIN_SECRET: secret,
      TM4_HTTP_LISTEN: `127.0.0.1:${port}`,
      TM4_MATCH_LISTEN: `127.0.0.1:${port + 1}`,
      TMPDIR: join(directory, "private"),
      TEMP: join(directory, "private"),
      TMP: join(directory, "private"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    for await (const bytes of stream) logs += new TextDecoder().decode(bytes);
  };
  output = Promise.all([
    capture(server.stdout as ReadableStream<Uint8Array>),
    capture(server.stderr as ReadableStream<Uint8Array>),
  ]).then(() => {});
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(`${address}/api/status`)).ok) return;
    } catch {
      /* Starting. */
    }
    await Bun.sleep(50);
  }
  throw new Error(`Server did not start: ${logs}`);
}, 15000);

afterAll(async () => {
  server?.kill("SIGTERM");
  if (server) await server.exited;
  await output;
  await rm(directory, { recursive: true, force: true });
});

test("a copied binary serves the complete site with no adjacent assets", async () => {
  const status: unknown = await (await fetch(`${address}/api/status`)).json();
  expect(status).toMatchObject({ phase: "setup" });
  for (const path of [
    "/",
    "/play/",
    "/style.css",
    "/server.js",
    "/play/web.js",
    "/play/network/tm4_network.js",
  ]) {
    const response = await fetch(address + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }
  const manifest: unknown = await (await fetch(`${address}/play/simulation-build.json`)).json();
  const wasm = await (await fetch(`${address}/play/tm4_web.wasm`)).arrayBuffer();
  const network = await (await fetch(`${address}/play/network/tm4_network_bg.wasm`)).arrayBuffer();
  expect(manifest).toMatchObject({
    sha256: new Bun.CryptoHasher("sha256").update(wasm).update(network).digest("hex"),
  });
  const head = await fetch(`${address}/play/tm4_web.wasm`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("application/wasm");
  expect(Number(head.headers.get("content-length"))).toBe(wasm.byteLength);
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  const range = await fetch(`${address}/play/tm4_web.wasm`, { headers: { Range: "bytes=0-3" } });
  expect(range.status).toBe(206);
  expect(new Uint8Array(await range.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]));
});

test("embedded files do not bypass path isolation or administrator authentication", async () => {
  for (const path of [
    "/tm4_standalone.wasm",
    "/DATA/MAIN.MR",
    "/api/no-such-route",
    "/%2e%2e%2fLICENSE",
  ]) {
    expect((await fetch(address + path)).status).toBe(404);
  }
  expect((await fetch(`${address}/api/resources`)).status).toBe(401);
  expect(
    (await fetch(`${address}/api/resources`, { headers: { Authorization: `Bearer ${secret}` } }))
      .status,
  ).toBe(200);
  expect(
    (await fetch(`${address}/play/tm4_web.wasm`, { headers: { Range: "bytes=9999999999-" } }))
      .status,
  ).toBe(416);
  expect(logs.includes(secret)).toBe(false);
});
