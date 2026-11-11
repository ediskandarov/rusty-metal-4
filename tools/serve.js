import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { inspectDisc } from "@tm4/resources/host/disc";

import { json, options, root } from "./common.js";
import { isolationHeaders, serveFile, staticFile } from "./server/files.js";

const args = options(["port", "site", "disc-dir"]);
const local = (await Bun.file(join(root, ".local/dev.json")).exists())
  ? await json(join(root, ".local/dev.json"))
  : {};
const site = await realpath(resolve(root, args.site ?? "build/dev/site"));
if (!(await Bun.file(join(site, "index.html")).exists()))
  throw new Error("Build the browser site first: bun run build:dev");
const discDirectory = args["disc-dir"] ?? process.env.TM4_DISC_DIR ?? local.discDirectory;
const disc = discDirectory
  ? await inspectDisc(resolve(root, discDirectory), await json(join(root, "config/disc.json")))
  : null;
for (const file of disc?.files ?? [])
  console.log(`${file.matchesReference ? "OK" : "Modified"} ${file.name}`);
for (const warning of disc?.warnings ?? []) console.warn(warning);
const port = Number(args.port ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");

const respond = (text, status) => new Response(text, { status, headers: isolationHeaders });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (!["GET", "HEAD"].includes(request.method)) return respond("Method not allowed", 405);
    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico")
      return new Response(null, { status: 204, headers: isolationHeaders });
    if (url.pathname === "/__dev/disc.json") {
      if (!disc)
        return respond(
          "Configure --disc-dir or TM4_DISC_DIR, or select a disc folder in the browser.",
          404,
        );
      return Response.json(
        {
          files: disc.files.map(({ name, size, sha256 }, index) => ({
            name,
            size,
            sha256,
            url: `/__dev/files/${index}`,
          })),
          warnings: disc.warnings,
        },
        { headers: { ...isolationHeaders, "Cache-Control": "no-store" } },
      );
    }
    if (url.pathname.startsWith("/__dev/")) {
      const match = /^\/__dev\/files\/(\d+)$/.exec(url.pathname);
      const source = match && disc?.files[Number(match[1])];
      return source ? serveFile(request, source.file) : respond("Not found", 404);
    }
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return respond("Invalid path", 400);
    }
    if (path.includes("\0")) return respond("Invalid path", 400);
    if (path.endsWith("/")) path += "index.html";
    const file = await staticFile(site, path);
    if (!file || !(await file.exists())) return respond("Not found", 404);
    return serveFile(request, file);
  },
});
console.log(`Open ${server.url}`);
if (!disc) console.log("No local disc configured; use the browser folder picker.");
