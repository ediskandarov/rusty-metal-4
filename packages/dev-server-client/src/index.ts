import { discManifestSchema } from "./schemas.ts";
export async function openDisc(url: URL, signal?: AbortSignal) {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Disc server: HTTP " + response.status);
  const manifest = discManifestSchema.parse(await response.json());
  const files = manifest.files.map((file) => {
    const sourceURL = new URL(file.url, url);
    if (sourceURL.origin !== url.origin) throw new Error("Disc file URL must use the local server");
    return {
      name: file.name,
      size: file.size,
      async read(offset: number, length: number, { signal }: { signal?: AbortSignal } = {}) {
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          offset + length > file.size
        )
          throw new Error("Read outside disc file");
        signal?.throwIfAborted();
        if (!length) return new Uint8Array(0);
        const response = await fetch(sourceURL, {
          signal,
          headers: { Range: "bytes=" + offset + "-" + (offset + length - 1) },
        });
        if (
          response.status !== 206 ||
          response.headers.get("Content-Range") !==
            "bytes " + offset + "-" + (offset + length - 1) + "/" + file.size
        )
          throw new Error("Invalid range response for " + file.name + ": HTTP " + response.status);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== length) throw new Error("Truncated download: " + file.name);
        return bytes;
      },
    };
  });
  return { files, warnings: manifest.warnings };
}
