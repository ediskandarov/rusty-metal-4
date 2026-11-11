import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return null;
  return { start, end };
}

export function serveFile(request, file) {
  const headers = {
    ...isolationHeaders,
    "Accept-Ranges": "bytes",
    "Content-Type": file.type || "application/octet-stream",
  };
  const rangeHeader = request.headers.get("Range");
  if (!rangeHeader) {
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { ...headers, "Content-Length": String(file.size) },
    });
  }
  const range = byteRange(rangeHeader, file.size);
  if (!range)
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${file.size}` },
    });
  const { start, end } = range;
  return new Response(request.method === "HEAD" ? null : file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${file.size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

export async function staticFile(directory, pathname) {
  const file = await realpath(resolve(directory, `.${pathname}`)).catch(() => null);
  if (!file) return null;
  const path = relative(directory, file);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || path.startsWith(sep)) return null;
  return Bun.file(file);
}
