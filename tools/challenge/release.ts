import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { challengeVersion } from "../../apps/rustymetal4.com/src/challenge.ts";

export interface ReleaseFile {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
}
export interface ReleaseManifest {
  buildId: string;
  version: string;
  diagnostic: boolean;
  files: ReleaseFile[];
}
export const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
export function contentType(path: string): string {
  const extension = path.split(".").pop();
  return (
    (
      {
        html: "text/html; charset=utf-8",
        js: "text/javascript; charset=utf-8",
        wasm: "application/wasm",
        json: "application/json",
        css: "text/css; charset=utf-8",
        txt: "text/plain; charset=utf-8",
        svg: "image/svg+xml",
        png: "image/png",
        map: "application/json",
      } as Record<string, string>
    )[extension ?? ""] ?? "application/octet-stream"
  );
}
// This list is intentionally public runtime code only. No DATA/, MR, IMG, BIN, VAB or disc files.
export function publicArtifact(path: string): boolean {
  return /^(?:index\.html|tm4_web\.(?:js|wasm)|simulation-build\.json|player-build\.json|challenge-build\.json|coi-serviceworker(?:\.LICENSE\.txt|\.js)|modules\/(?:tm3\/)?[a-z0-9_]+\.wasm|_astro\/[A-Za-z0-9_.-]+\.(?:js|css|map|svg|png|wasm))$/.test(
    path,
  );
}
export async function inventory(directory: string): Promise<ReleaseFile[]> {
  const files: ReleaseFile[] = [];
  async function walk(prefix = "") {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await lstat(join(directory, path));
      if (stat.isSymbolicLink()) throw new Error(`Release contains a symbolic link: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (path !== "release.json") {
        if (!publicArtifact(path)) throw new Error(`Not a public player artifact: ${path}`);
        const bytes = new Uint8Array(await Bun.file(join(directory, path)).arrayBuffer());
        files.push({
          path,
          sha256: sha256(bytes),
          size: bytes.length,
          contentType: contentType(path),
        });
      }
    }
  }
  await walk();
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function releaseId(files: ReleaseFile[], diagnostic: boolean): string {
  return sha256(JSON.stringify({ version: challengeVersion, diagnostic, files }));
}
export async function assertChallengeRuntime(site: string, diagnostic: boolean): Promise<void> {
  const player = (await Bun.file(join(site, "player-build.json")).json()) as {
    challenge?: unknown;
  };
  if (player.challenge !== true)
    throw new Error("This player frontend was not built for the 200 Challenge");
  const module = new WebAssembly.Module(await Bun.file(join(site, "tm4_web.wasm")).arrayBuffer());
  const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
  if (!exports.includes("WebChallengeCapacity"))
    throw new Error("This is not a dedicated 200 Challenge runtime");
  if (exports.includes("WebTestRestartNetworkReplay") !== diagnostic)
    throw new Error("Challenge diagnostic flag does not match its compiler output");
}

export async function verifyRelease(directory: string): Promise<ReleaseManifest> {
  const manifest = (await Bun.file(join(directory, "release.json")).json()) as ReleaseManifest;
  const files = await inventory(directory);
  if (
    manifest.version !== challengeVersion ||
    JSON.stringify(files) !== JSON.stringify(manifest.files) ||
    manifest.buildId !== releaseId(files, manifest.diagnostic)
  )
    throw new Error("Challenge release files do not match their immutable build ID");
  for (const required of [
    "index.html",
    "tm4_web.js",
    "tm4_web.wasm",
    "simulation-build.json",
    "player-build.json",
    "challenge-build.json",
  ])
    if (!files.some((file) => file.path === required))
      throw new Error(`Missing release artifact: ${required}`);
  if (!files.some((file) => file.path.startsWith("modules/")))
    throw new Error("Missing resource modules");
  return manifest;
}
