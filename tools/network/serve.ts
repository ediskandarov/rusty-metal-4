import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isolationHeaders, serveFile, staticFile } from "../server/files.js";

export async function serveHost(options: {
  site: string;
  api: string;
  hostname?: string;
  port: number;
}) {
  const site = await realpath(options.site);
  if (!(await Bun.file(join(site, "index.html")).exists()))
    throw new Error("Build the server web app first");
  const api = new URL(options.api);
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        try {
          const forwarded = new Request(new URL(url.pathname + url.search, api), request);
          forwarded.headers.delete("host");
          return await fetch(forwarded, { redirect: "manual" });
        } catch {
          return new Response("Native server unavailable", {
            status: 503,
            headers: isolationHeaders,
          });
        }
      }
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405, headers: isolationHeaders });
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        return new Response(null, { status: 400, headers: isolationHeaders });
      }
      if (path.endsWith("/")) path += "index.html";
      const file = await staticFile(site, path);
      return file && (await file.exists())
        ? serveFile(file)
        : new Response(null, { status: 404, headers: isolationHeaders });
    },
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "dev" },
      port: { type: "string", default: "8120" },
      api: { type: "string", default: "http://127.0.0.1:8121" },
    },
  });
  if (!["dev", "release", "diagnostic"].includes(values.mode))
    throw new Error("Unknown build mode");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const server = await serveHost({
    site: resolve(import.meta.dir, "../../build", values.mode, "server-site"),
    api: values.api,
    port,
  });
  console.log(`Server web app: ${server.url}`);
}
