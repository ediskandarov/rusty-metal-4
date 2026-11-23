import { unzipSync, zipSync } from "fflate";
import { z } from "zod";

export const maxModBytes = 256 * 1024 * 1024;
const maxFileBytes = 64 * 1024 * 1024;
const maxEntries = 512;
const maxManifestBytes = 256 * 1024;
const encoder = new TextEncoder();

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/);
const label = z
  .string()
  .min(1)
  .max(80)
  .refine((text) =>
    [...text].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
  );
const payloadPath = z
  .string()
  .max(160)
  .regex(/^files\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?$/);
const discPath = z
  .string()
  .max(80)
  .regex(/^\/DATA\/(?:[A-Z0-9_]+\/)*[A-Z0-9_]+\.(?:MR|IMG|TIM|VAB)$/);
const mrName = z
  .string()
  .max(80)
  .regex(/^[A-Za-z0-9_ .()'-]+$/)
  .refine((name) => name !== "." && name !== "..");
const releaseRef = z.strictObject({ id, digest: hash });

const plan = z.strictObject({
  format: z.literal("rm4-mod/1"),
  id,
  name: label,
  version: label,
  // Code-bearing releases are initially pinned to the engine build that verified them.
  runtime: hash.optional(),
  requires: z.array(releaseRef).max(32),
  base: z.array(z.strictObject({ path: discPath, sha256: hash })).max(64),
  contents: z.array(z.strictObject({ id, name: label, kind: z.enum(["car", "map"]) })).max(128),
  mounts: z.array(z.strictObject({ path: discPath, source: payloadPath })).max(256),
  registry: z
    .array(
      z.strictObject({
        archive: discPath.refine((path) => path.endsWith(".MR")),
        folder: z.array(mrName).max(12),
        name: mrName,
        source: payloadPath,
        kind: z.enum(["folder", "binary"]),
      }),
    )
    .max(256),
});
const manifestSchema = plan.extend({
  files: z
    .array(
      z.strictObject({
        path: payloadPath,
        size: z.number().int().min(1).max(maxFileBytes),
        sha256: hash,
      }),
    )
    .min(1)
    .max(maxEntries - 1),
});

export type ModPlan = z.infer<typeof plan>;
export type ModManifest = z.infer<typeof manifestSchema>;
export type ModRef = z.infer<typeof releaseRef>;
export interface ModDraft {
  plan: ModPlan;
  files: Map<string, Uint8Array<ArrayBuffer>>;
}
export interface ModPackage {
  manifest: ModManifest;
  digest: string;
  files: Map<string, Uint8Array<ArrayBuffer>>;
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function unique(keys: string[], description: string) {
  if (new Set(keys).size !== keys.length) throw Error(`Duplicate mod ${description}`);
}

function validatePlan(manifest: ModManifest) {
  unique(
    manifest.requires.map(({ id }) => id),
    "dependency",
  );
  unique(
    manifest.base.map(({ path }) => path),
    "base resource",
  );
  unique(
    manifest.contents.map(({ id }) => id),
    "content ID",
  );
  unique(
    manifest.mounts.map(({ path }) => path),
    "mount",
  );
  unique(
    manifest.registry.map(({ archive, folder, name }) =>
      [archive, ...folder, name].join("/").toLowerCase(),
    ),
    "registry entry",
  );
  for (const { archive, folder, name } of manifest.registry) {
    if (archive !== "/DATA/MAIN.MR") continue;
    const path = folder.join("/").toLowerCase();
    if (path === "objects/car/characters" && name.length > 11)
      throw Error(`Car registry key exceeds 11 bytes: ${name}`);
    if (path === "worlds" && name.length > 19)
      throw Error(`Map registry key exceeds 19 bytes: ${name}`);
  }
  const paths = new Set(manifest.files.map(({ path }) => path));
  const used = new Set([...manifest.mounts, ...manifest.registry].map(({ source }) => source));
  for (const path of used) {
    if (!paths.has(path)) throw Error(`Missing mod payload ${path}`);
  }
  for (const path of paths) {
    if (!used.has(path)) throw Error(`Unused mod payload ${path}`);
  }
}

export async function readMod(bytes: Uint8Array<ArrayBuffer>): Promise<ModPackage> {
  if (bytes.length < 22 || bytes.length > maxModBytes) throw Error("Invalid mod archive size");
  const seen = new Set<string>();
  let total = 0;
  const extracted = unzipSync(bytes, {
    filter({ name, size, originalSize, compression }) {
      if (seen.has(name) || seen.size >= maxEntries) throw Error("Invalid mod archive entries");
      if (name !== "manifest.json" && !payloadPath.safeParse(name).success)
        throw Error(`Invalid mod archive path ${name}`);
      // Stored entries let us bound allocations even for malformed ZIP directories.
      const limit = name === "manifest.json" ? maxManifestBytes : maxFileBytes;
      total += size;
      if (compression || size !== originalSize || size < 1 || size > limit || total > bytes.length)
        throw Error("Mod archives must contain bounded, uncompressed entries");
      seen.add(name);
      return true;
    },
  });
  const metadata = extracted["manifest.json"];
  if (!metadata) throw Error("Missing mod manifest");
  const manifest = manifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata)),
  );
  manifest.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  unique(
    manifest.files.map(({ path }) => path),
    "file path",
  );
  if (seen.size !== manifest.files.length + 1)
    throw Error("Mod file inventory does not match archive");
  validatePlan(manifest);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const { path, size, sha256: expected } of manifest.files) {
    const data = extracted[path];
    if (!data || data.length !== size || (await sha256(data)) !== expected)
      throw Error(`Mod payload verification failed: ${path}`);
    files.set(path, data);
  }
  return { manifest, files, digest: await sha256(encoder.encode(JSON.stringify(manifest))) };
}

export async function packMod(draft: ModDraft) {
  if (draft.files.size >= maxEntries) throw Error("Too many mod payload files");
  let total = 0;
  const files = [];
  for (const path of [...draft.files.keys()].sort()) {
    payloadPath.parse(path);
    const data = draft.files.get(path)!;
    total += data.length;
    if (total > maxModBytes || data.length > maxFileBytes) throw Error("Mod payload is too large");
    files.push({ path, size: data.length, sha256: await sha256(data) });
  }
  const manifest = manifestSchema.parse({ ...draft.plan, files });
  validatePlan(manifest);
  const metadata = encoder.encode(JSON.stringify(manifest));
  if (metadata.length > maxManifestBytes) throw Error("Mod manifest is too large");
  const archive = zipSync(
    {
      "manifest.json": metadata,
      ...Object.fromEntries(draft.files),
    },
    { level: 0, mtime: new Date(2000, 0, 1) },
  );
  if (archive.length > maxModBytes) throw Error("Mod archive is too large");
  return archive;
}

export function resolveMods<T extends Pick<ModPackage, "manifest" | "digest">>(
  installed: readonly T[],
  enabled: readonly string[],
): T[] {
  const byDigest = new Map(installed.map((mod) => [mod.digest, mod]));
  const byId = new Map<string, T>();
  const visiting = new Set<string>();
  const ordered: T[] = [];
  const roots = enabled.map((digest) => {
    const mod = byDigest.get(digest);
    if (!mod) throw Error(`Missing mod release ${digest}`);
    return mod;
  });
  function visit(mod: T) {
    const { id, requires } = mod.manifest;
    if (visiting.has(id)) throw Error(`Mod dependency cycle at ${id}`);
    const previous = byId.get(id);
    if (previous) {
      if (previous.digest !== mod.digest) throw Error(`Select one release of ${id}`);
      return;
    }
    byId.set(id, mod);
    visiting.add(id);
    for (const required of [...requires].sort(byModId)) {
      const dependency = byDigest.get(required.digest);
      if (dependency?.manifest.id !== required.id)
        throw Error(
          `${mod.manifest.name} requires ${required.id} (${required.digest.slice(0, 12)})`,
        );
      visit(dependency);
    }
    visiting.delete(id);
    ordered.push(mod);
  }
  for (const mod of roots.sort((a, b) => byModId(a.manifest, b.manifest))) visit(mod);
  unique(
    ordered.flatMap(({ manifest }) => manifest.contents.map(({ id }) => id)),
    "content ID",
  );
  unique(
    ordered.flatMap(({ manifest }) => manifest.mounts.map(({ path }) => path)),
    "mount",
  );
  unique(
    ordered.flatMap(({ manifest }) =>
      manifest.registry.map(({ archive, folder, name }) =>
        [archive, ...folder, name].join("/").toLowerCase(),
      ),
    ),
    "registry entry",
  );
  return ordered;
}

function byModId(a: { id: string }, b: { id: string }) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
