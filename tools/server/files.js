import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

export function serveFile(file) {
  return new Response(file, {
    headers: {
      ...isolationHeaders,
      "Content-Type": file.type || "application/octet-stream",
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
