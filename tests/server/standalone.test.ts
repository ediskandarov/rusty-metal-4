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

test("a copied binary runs its API without adjacent files or a website", async () => {
  const status: unknown = await (await fetch(`${address}/api/status`)).json();
  expect(status).toMatchObject({ phase: "setup" });
  for (const path of [
    "/",
    "/play/",
    "/style.css",
    "/server.js",
    "/play/tm4_web.wasm",
    "/simulation-build.json",
    "/tm4_standalone.wasm",
    "/DATA/MAIN.MR",
    "/%2e%2e%2fLICENSE",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(address + path, { method, headers: { Range: "bytes=0-3" } });
      expect(response.status).toBe(404);
    }
  }
});

test("private APIs require administrator authentication", async () => {
  for (const path of ["/api/resources", "/api/metrics"])
    expect((await fetch(address + path)).status).toBe(401);
  expect(
    (await fetch(`${address}/api/resources`, { headers: { Authorization: `Bearer ${secret}` } }))
      .status,
  ).toBe(200);
  expect(logs.includes(secret)).toBe(false);
});
