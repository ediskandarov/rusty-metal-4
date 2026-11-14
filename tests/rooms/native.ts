import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

// Local test adapter for the production Room -> TestServer boundary. It launches the
// real native process with private temp files; no Cloudflare container is deployed.
export async function nativeBridge(
  bundle: string,
  executable: string,
  fixture?: string,
  limits?: { timeLimitTicks: number; fragLimit: number },
) {
  await mkdir("build/room-tests", { recursive: true });
  const privateRoot = await mkdtemp(resolve("build/room-tests/private-"));
  const processes = new Map<
    string,
    { process: Subprocess; api: number; match: number; secret: string }
  >();
  const history: { id: string; phase: string }[] = [];
  let port = 19240;
  let log = "";
  let starts = 0;
  let stops = 0;
  type Link = {
    upstream: WebSocket;
    pending: (string | Uint8Array)[];
    socket?: ServerWebSocket<Link>;
  };
  const kill = async (id: string) => {
    const native = processes.get(id);
    if (!native) return;
    native.process.kill("SIGTERM");
    const timer = setTimeout(() => native.process.kill("SIGKILL"), 18_000);
    await native.process.exited;
    clearTimeout(timer);
    processes.delete(id);
    stops++;
  };
  const host = Bun.serve<Link>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const [, id, ...parts] = url.pathname.split("/");
      const path = "/" + parts.join("/");
      if (!id) return new Response("Missing server", { status: 404 });
      if (path === "/_server/stop") {
        await kill(id);
        return new Response(null, { status: 204 });
      }
      let native = processes.get(id);
      if (!native && path === "/api/resources") {
        const api = port++,
          match = port++,
          secret = crypto.randomUUID();
        const process = Bun.spawn([executable, "--serve", "2"], {
          env: {
            ...Bun.env,
            TM4_ADMIN_SECRET: secret,
            TM4_HTTP_LISTEN: "127.0.0.1:" + api,
            TM4_MATCH_LISTEN: "127.0.0.1:" + match,
            TM4_SIMULATION_BUILD: resolve(bundle, "simulation-build.json"),
            TM4_SIMULATION_WASM: resolve(bundle, "tm4_standalone.wasm"),
            TM4_TEST_ACTIONS: fixture,
            TMPDIR: privateRoot,
            TM4_JOURNAL_DIR: resolve("build/room-tests/journals"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        for (const stream of [process.stdout, process.stderr])
          void (async () => {
            for await (const chunk of stream as ReadableStream<Uint8Array>)
              log += new TextDecoder().decode(chunk);
          })();
        native = { process, api, match, secret };
        processes.set(id, native);
        starts++;
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            if ((await fetch("http://127.0.0.1:" + api + "/api/status")).ok) {
              ready = true;
              break;
            }
          } catch {
            /* Booting. */
          }
          if (process.exitCode !== null) break;
          await Bun.sleep(100);
        }
        if (!ready) return new Response("Native startup failed: " + log, { status: 503 });
      }
      if (!native) return new Response("Server stopped", { status: 409 });
      if (path === "/match") {
        const upstream = new WebSocket("ws://127.0.0.1:" + native.match + "/");
        upstream.binaryType = "arraybuffer";
        const link: Link = { upstream, pending: [] };
        upstream.onopen = () => {
          for (const message of link.pending) upstream.send(message);
          link.pending = [];
        };
        upstream.onmessage = (event) => link.socket?.send(event.data as string | ArrayBuffer);
        upstream.onclose = () => link.socket?.close();
        upstream.onerror = () => link.socket?.close();
        if (server.upgrade(request, { data: link })) return;
        upstream.close();
        return new Response("Upgrade required", { status: 426 });
      }
      const headers = new Headers(request.headers);
      headers.set("Authorization", "Bearer " + native.secret);
      headers.delete("host");
      if (path === "/api/start" && limits) headers.delete("content-length");
      const response = await fetch(
        "http://127.0.0.1:" + native.api + (path === "/_server/journal" ? "/api/journal" : path),
        {
          method: request.method,
          headers,
          body:
            path === "/api/start" && limits
              ? JSON.stringify({ ...((await request.json()) as object), limits })
              : request.body,
        },
      );
      if (["/api/journal", "/_server/journal"].includes(path) && response.ok) {
        // Bun's streaming proxy drops the upstream length. Preserve the bounded
        // fixture's exact response length so the production archive validator runs.
        const bytes = await response.arrayBuffer();
        const headers = new Headers(response.headers);
        headers.set("Content-Length", String(bytes.byteLength));
        return new Response(bytes, { status: response.status, headers });
      }
      if (path === "/api/status" && response.ok) {
        const status = (await response.clone().json()) as { phase: string };
        history.push({ id, phase: status.phase });
      }
      return response;
    },
    websocket: {
      open(socket) {
        socket.data.socket = socket;
      },
      message(socket, message) {
        const { upstream, pending } = socket.data;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
        else pending.push(message);
      },
      close(socket) {
        socket.data.upstream.close();
      },
    },
  });
  return {
    url: host.url.origin,
    history,
    get log() {
      return log;
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    async close() {
      for (const id of processes.keys()) await kill(id);
      await host.stop(true);
      if ((await readdir(privateRoot)).length)
        throw new Error("Native private uploads survived shutdown");
      await Bun.write("build/room-tests/native.log", log);
    },
  };
}
