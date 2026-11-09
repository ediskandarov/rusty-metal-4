import { readdir, realpath } from "node:fs/promises";
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

export async function inspectDisc(directory, reference) {
  const root = await realpath(directory);
  const files = [];
  const warnings = [];
  const names = (await readdir(root)).filter((name) => /\.(cue|bin)$/i.test(name)).sort();
  if (!names.some((name) => /\.bin$/i.test(name)))
    throw new Error("No BIN files in the disc directory");
  for (const name of names) {
    const path = await realpath(resolve(root, name));
    if (relative(root, path).startsWith(".."))
      throw new Error(`Disc file escapes its directory: ${name}`);
    const file = Bun.file(path);
    const hash = new Bun.CryptoHasher("sha256");
    for await (const chunk of file.stream()) hash.update(chunk);
    const sha256 = hash.digest("hex");
    const expected = reference.files.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (!expected || expected.sha256 !== sha256)
      warnings.push(
        `Modified or unrecognized disc file: ${name}. Resource compatibility will be checked in the browser.`,
      );
    files.push({ name, size: file.size, sha256, file });
    console.log(`${expected?.sha256 === sha256 ? "OK" : "Modified"} ${name}`);
  }
  for (const expected of reference.files) {
    if (!names.some((name) => name.toLowerCase() === expected.name.toLowerCase()))
      warnings.push(`Missing disc file: ${expected.name}`);
  }
  return { files, warnings };
}
